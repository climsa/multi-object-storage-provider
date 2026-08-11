import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { LookupFunction } from "node:net";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const PROVIDER_OPERATION_TIMEOUT_MS = 10_000;

export interface S3ProviderCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3ProviderAdapterOptions {
  addressingMode: "AUTO" | "VIRTUAL_HOSTED" | "PATH_STYLE";
  credentials: S3ProviderCredentials;
  endpoint: string;
  endpointLookup?: LookupFunction;
  operationTimeoutMs?: number;
  region: string;
}

export interface ProviderCapabilityResult {
  capability: string;
  details?: Record<string, string>;
  supported: boolean;
}

export interface ConnectionTestResult {
  bucketName?: string;
  bucketNames: string[];
  capabilities: ProviderCapabilityResult[];
}

export interface PresignedTransfer {
  expiresAt: Date;
  headers?: Record<string, string>;
  url: string;
}

export interface ProviderObjectMetadata {
  checksumSha256?: string;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
  sizeBytes: bigint;
}

export interface ProviderObjectStream {
  body: Readable;
  metadata: ProviderObjectMetadata;
}

export interface ProviderObjectListItem {
  etag?: string;
  key: string;
  lastModified?: Date;
  sizeBytes: bigint;
  storageClass?: string;
}

export interface ProviderObjectListResult {
  commonPrefixes: string[];
  nextContinuationToken?: string;
  objects: ProviderObjectListItem[];
}

export interface ProviderObjectListOptions {
  continuationToken?: string;
  delimiter?: string;
  maxKeys?: number;
  prefix?: string;
}

export interface MultipartUpload {
  uploadId: string;
}

export interface MultipartPartInput {
  etag: string;
  partNumber: number;
}

function errorDetails(error: unknown): Record<string, string> {
  if (!error || typeof error !== "object") return {};
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  const details: Record<string, string> = {};
  if (typeof candidate.name === "string") details.code = candidate.name;
  if (typeof candidate.$metadata?.httpStatusCode === "number") {
    details.status = String(candidate.$metadata.httpStatusCode);
  }
  return details;
}

export class S3ProviderAdapter {
  private readonly client: S3Client;
  private readonly operationTimeoutMs: number;

  public constructor(private readonly options: S3ProviderAdapterOptions) {
    this.operationTimeoutMs = options.operationTimeoutMs ?? PROVIDER_OPERATION_TIMEOUT_MS;
    if (!Number.isInteger(this.operationTimeoutMs) || this.operationTimeoutMs < 1_000 || this.operationTimeoutMs > 15 * 60 * 1000) {
      throw new RangeError("operationTimeoutMs must be between 1000 and 900000 milliseconds");
    }
    const requestHandler = options.endpointLookup
      ? new NodeHttpHandler({
          connectionTimeout: this.operationTimeoutMs,
          requestTimeout: this.operationTimeoutMs,
          socketTimeout: this.operationTimeoutMs,
          httpAgent: new HttpAgent({
            lookup: options.endpointLookup,
            maxSockets: 64,
          }),
          httpsAgent: new HttpsAgent({
            lookup: options.endpointLookup,
            maxSockets: 64,
          }),
        })
      : undefined;
    const config: S3ClientConfig = {
      credentials: options.credentials,
      endpoint: options.endpoint,
      forcePathStyle: options.addressingMode === "PATH_STYLE",
      // S3 region redirects must never make the client follow an unvalidated
      // destination. The endpoint and per-socket DNS guard remain authoritative.
      followRegionRedirects: false,
      region: options.region,
      ...(requestHandler ? { requestHandler } : {}),
    };
    this.client = new S3Client(config);
  }

  public async testConnection(bucketName?: string): Promise<ConnectionTestResult> {
    const bucketNames: string[] = [];
    const capabilities: ProviderCapabilityResult[] = [];

    if (bucketName) {
      await this.testBucketAccess(bucketName);
      capabilities.push({ capability: "headBucket", supported: true });
    } else {
      const listed = await this.client.send(
        new ListBucketsCommand({}),
        { abortSignal: AbortSignal.timeout(PROVIDER_OPERATION_TIMEOUT_MS) },
      );
      bucketNames.push(...(listed.Buckets ?? []).flatMap((bucket) =>
        bucket.Name ? [bucket.Name] : [],
      ));
      capabilities.push({ capability: "listBuckets", supported: true });
    }

    if (bucketName) {
      capabilities.push(...(await this.probePresignedUrls(bucketName)));
      capabilities.push(await this.probeMultipart(bucketName));
    }

    return bucketName
      ? { bucketName, bucketNames, capabilities }
      : { bucketNames, capabilities };
  }

  /**
   * Validates that a caller can access an existing bucket without requiring
   * write, presign, or multipart permissions. Bucket import must work for
   * read-only provider credentials; capability probing remains the job of the
   * explicit provider test flow above.
   */
  public async testBucketAccess(bucketName: string): Promise<void> {
    await this.client.send(
      new HeadBucketCommand({ Bucket: bucketName }),
      { abortSignal: AbortSignal.timeout(PROVIDER_OPERATION_TIMEOUT_MS) },
    );
  }

  public async listObjects(
    bucketName: string,
    options: ProviderObjectListOptions = {},
  ): Promise<ProviderObjectListResult> {
    const maxKeys = options.maxKeys ?? 100;
    if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1_000) {
      throw new RangeError("maxKeys must be between 1 and 1000");
    }

    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Delimiter: options.delimiter ?? "/",
        MaxKeys: maxKeys,
        ...(options.prefix ? { Prefix: options.prefix } : {}),
        ...(options.continuationToken
          ? { ContinuationToken: options.continuationToken }
          : {}),
      }),
      { abortSignal: AbortSignal.timeout(this.operationTimeoutMs) },
    );

    return {
      commonPrefixes: (result.CommonPrefixes ?? []).flatMap((entry) =>
        entry.Prefix ? [entry.Prefix] : [],
      ),
      objects: (result.Contents ?? []).flatMap((object) =>
        object.Key
          ? [{
              key: object.Key,
              sizeBytes: BigInt(object.Size ?? 0),
              ...(object.ETag ? { etag: object.ETag } : {}),
              ...(object.LastModified ? { lastModified: object.LastModified } : {}),
              ...(object.StorageClass ? { storageClass: object.StorageClass } : {}),
            }]
          : [],
      ),
      ...(result.IsTruncated && result.NextContinuationToken
        ? { nextContinuationToken: result.NextContinuationToken }
        : {}),
    };
  }

  public async probeMultipart(bucketName: string): Promise<ProviderCapabilityResult> {
    const key = `.mosp-capability-probe/${randomUUID()}`;
    let uploadId: string | undefined;

    try {
      const created = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucketName,
          Key: key,
          Metadata: { "mosp-probe": "true" },
        }),
        { abortSignal: AbortSignal.timeout(PROVIDER_OPERATION_TIMEOUT_MS) },
      );
      uploadId = created.UploadId;
      return { capability: "multipart", supported: Boolean(uploadId) };
    } catch (error) {
      return {
        capability: "multipart",
        details: errorDetails(error),
        supported: false,
      };
    } finally {
      if (uploadId) {
        await this.client
          .send(
            new AbortMultipartUploadCommand({ Bucket: bucketName, Key: key, UploadId: uploadId }),
            { abortSignal: AbortSignal.timeout(PROVIDER_OPERATION_TIMEOUT_MS) },
          )
          .catch(() => undefined);
      }
    }
  }

  public async createPresignedUpload(
    bucketName: string,
    key: string,
    contentType: string | undefined,
    expiresInSeconds = 900,
  ): Promise<PresignedTransfer> {
    const expires = this.safeExpiry(expiresInSeconds);
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
      { expiresIn: expires },
    );
    return {
      url,
      expiresAt: new Date(Date.now() + expires * 1000),
      ...(contentType ? { headers: { "content-type": contentType } } : {}),
    };
  }

  public async createPresignedDownload(
    bucketName: string,
    key: string,
    expiresInSeconds = 900,
  ): Promise<PresignedTransfer> {
    const expires = this.safeExpiry(expiresInSeconds);
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
        ResponseContentDisposition: "attachment",
      }),
      { expiresIn: expires },
    );
    return { url, expiresAt: new Date(Date.now() + expires * 1000) };
  }

  public async createMultipartUpload(
    bucketName: string,
    key: string,
    contentType?: string,
  ): Promise<MultipartUpload> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucketName,
        Key: key,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
      { abortSignal: AbortSignal.timeout(PROVIDER_OPERATION_TIMEOUT_MS) },
    );
    if (!result.UploadId) throw new Error("PROVIDER_DID_NOT_RETURN_UPLOAD_ID");
    return { uploadId: result.UploadId };
  }

  public async createPresignedUploadPart(
    bucketName: string,
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds = 900,
  ): Promise<PresignedTransfer> {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new RangeError("partNumber must be between 1 and 10000");
    }
    const expires = this.safeExpiry(expiresInSeconds);
    const url = await getSignedUrl(
      this.client,
      new UploadPartCommand({ Bucket: bucketName, Key: key, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: expires },
    );
    return { url, expiresAt: new Date(Date.now() + expires * 1000) };
  }

  public async completeMultipartUpload(
    bucketName: string,
    key: string,
    uploadId: string,
    parts: readonly MultipartPartInput[],
  ): Promise<void> {
    if (parts.length === 0 || parts.length > 10_000) {
      throw new RangeError("multipart completion requires 1 to 10000 parts");
    }
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucketName,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({ ETag: part.etag, PartNumber: part.partNumber })),
        },
      }),
      { abortSignal: AbortSignal.timeout(PROVIDER_OPERATION_TIMEOUT_MS) },
    );
  }

  public async abortMultipartUpload(
    bucketName: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: bucketName, Key: key, UploadId: uploadId }),
      { abortSignal: AbortSignal.timeout(PROVIDER_OPERATION_TIMEOUT_MS) },
    );
  }

  public async headObject(bucketName: string, key: string): Promise<ProviderObjectMetadata> {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: bucketName, Key: key }),
      { abortSignal: AbortSignal.timeout(PROVIDER_OPERATION_TIMEOUT_MS) },
    );
    return {
      ...(result.ChecksumSHA256 ? { checksumSha256: result.ChecksumSHA256 } : {}),
      ...(result.ContentType ? { contentType: result.ContentType } : {}),
      ...(result.ETag ? { etag: result.ETag } : {}),
      ...(result.LastModified ? { lastModified: result.LastModified } : {}),
      sizeBytes: BigInt(result.ContentLength ?? 0),
    };
  }

  public async getObject(
    bucketName: string,
    key: string,
    abortSignal?: AbortSignal,
  ): Promise<ProviderObjectStream> {
    const timeoutSignal = AbortSignal.timeout(this.operationTimeoutMs);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: key }),
      { abortSignal: signal },
    );
    if (!result.Body) throw new Error("PROVIDER_RETURNED_EMPTY_BODY");
    return {
      body: result.Body as unknown as Readable,
      metadata: {
        ...(result.ChecksumSHA256 ? { checksumSha256: result.ChecksumSHA256 } : {}),
        ...(result.ContentType ? { contentType: result.ContentType } : {}),
        ...(result.ETag ? { etag: result.ETag } : {}),
        ...(result.LastModified ? { lastModified: result.LastModified } : {}),
        sizeBytes: BigInt(result.ContentLength ?? 0),
      },
    };
  }

  public async putObject(
    bucketName: string,
    key: string,
    body: Readable,
    contentType?: string | null,
    contentLengthBytes?: number,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(this.operationTimeoutMs);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
        ...(contentLengthBytes !== undefined
          ? { ContentLength: contentLengthBytes }
          : {}),
      }),
      { abortSignal: signal },
    );
  }

  public async objectExists(bucketName: string, key: string): Promise<boolean> {
    try {
      await this.headObject(bucketName, key);
      return true;
    } catch (error) {
      const status =
        error && typeof error === "object" && "$metadata" in error
          ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
          : undefined;
      if (status === 404) return false;
      throw error;
    }
  }

  public async deleteObject(bucketName: string, key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: bucketName, Key: key }),
      { abortSignal: AbortSignal.timeout(PROVIDER_OPERATION_TIMEOUT_MS) },
    );
  }

  private safeExpiry(expiresInSeconds: number): number {
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 900) {
      throw new RangeError("expiresInSeconds must be between 60 and 900 seconds");
    }
    return expiresInSeconds;
  }

  private async probePresignedUrls(bucketName: string): Promise<ProviderCapabilityResult[]> {
    const key = `.mosp-capability-probe/${randomUUID()}`;

    try {
      await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: bucketName, Key: key }),
        { expiresIn: 60 },
      );
      await getSignedUrl(
        this.client,
        new PutObjectCommand({ Bucket: bucketName, Key: key }),
        { expiresIn: 60 },
      );
      return [
        { capability: "presignedGet", supported: true },
        { capability: "presignedPut", supported: true },
      ];
    } catch (error) {
      const details = errorDetails(error);
      return [
        { capability: "presignedGet", details, supported: false },
        { capability: "presignedPut", details, supported: false },
      ];
    }
  }
}
