import { describe, expect, it, vi } from "vitest";

import { S3ProviderAdapter } from "./adapter.js";

function createAdapter() {
  return new S3ProviderAdapter({
    addressingMode: "PATH_STYLE",
    credentials: { accessKeyId: "access", secretAccessKey: "secret" },
    endpoint: "https://storage.example.com",
    region: "us-east-1",
  });
}

describe("S3ProviderAdapter multipart validation", () => {
  it("rejects invalid multipart part numbers before provider I/O", async () => {
    await expect(
      createAdapter().createPresignedUploadPart("archive", "object", "upload-1", 0),
    ).rejects.toThrow(RangeError);
    await expect(
      createAdapter().createPresignedUploadPart("archive", "object", "upload-1", 1, 59),
    ).rejects.toThrow(RangeError);
  });

  it("rejects empty multipart completion before provider I/O", async () => {
    await expect(
      createAdapter().completeMultipartUpload("archive", "object", "upload-1", []),
    ).rejects.toThrow(RangeError);
  });
});

describe("S3ProviderAdapter bucket access", () => {
  it("checks an existing bucket with HEAD only", async () => {
    const adapter = createAdapter();
    const client = (adapter as unknown as { client: { send: (command: unknown) => Promise<unknown> } }).client;
    const send = vi.spyOn(client, "send").mockResolvedValue({});

    await adapter.testBucketAccess("archive");

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]?.constructor.name).toBe("HeadBucketCommand");
  });

  it("lists object metadata, folders, and the next provider cursor", async () => {
    const adapter = createAdapter();
    const client = (adapter as unknown as { client: { send: (command: unknown) => Promise<unknown> } }).client;
    const send = vi.spyOn(client, "send").mockResolvedValue({
      CommonPrefixes: [{ Prefix: "photos/2029/" }],
      Contents: [{
        ETag: "etag-1",
        Key: "photos/image.jpg",
        LastModified: new Date("2030-01-01T00:00:00.000Z"),
        Size: 42,
        StorageClass: "STANDARD",
      }],
      IsTruncated: true,
      NextContinuationToken: "next-provider-cursor",
    });

    const result = await adapter.listObjects("archive", {
      continuationToken: "current-provider-cursor",
      maxKeys: 25,
      prefix: "photos/",
    });

    expect(send.mock.calls[0]?.[0]?.constructor.name).toBe("ListObjectsV2Command");
    expect((send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input).toMatchObject({
      Bucket: "archive",
      ContinuationToken: "current-provider-cursor",
      Delimiter: "/",
      MaxKeys: 25,
      Prefix: "photos/",
    });
    expect(result).toEqual({
      commonPrefixes: ["photos/2029/"],
      nextContinuationToken: "next-provider-cursor",
      objects: [{
        etag: "etag-1",
        key: "photos/image.jpg",
        lastModified: new Date("2030-01-01T00:00:00.000Z"),
        sizeBytes: 42n,
        storageClass: "STANDARD",
      }],
    });
  });

  it("rejects an unsafe page size before provider I/O", async () => {
    await expect(createAdapter().listObjects("archive", { maxKeys: 0 })).rejects.toThrow(RangeError);
    await expect(createAdapter().listObjects("archive", { maxKeys: 1_001 })).rejects.toThrow(RangeError);
  });
});
