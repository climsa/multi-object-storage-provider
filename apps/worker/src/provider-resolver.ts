import {
  LocalFileKeyEncryptionKeyProvider,
  ProviderCredentialCipher,
} from "@mosp/storage-core";
import {
  S3ProviderAdapter,
  assertSafeProviderEndpoint,
  createSafeProviderLookup,
} from "@mosp/provider-s3";
import type { PrismaClient } from "@mosp/db";

export interface WorkerProviderResolverOptions {
  allowHttp: boolean;
  allowPrivateNetwork: boolean;
  allowedPorts: readonly number[];
  credentialKeyFile: string;
}

export class WorkerProviderResolver {
  private readonly cipher: ProviderCredentialCipher;

  public constructor(
    private readonly database: PrismaClient,
    options: WorkerProviderResolverOptions,
  ) {
    this.cipher = new ProviderCredentialCipher(
      new LocalFileKeyEncryptionKeyProvider(options.credentialKeyFile),
    );
    this.allowHttp = options.allowHttp;
    this.allowPrivateNetwork = options.allowPrivateNetwork;
    this.allowedPorts = options.allowedPorts;
  }

  private readonly allowHttp: boolean;
  private readonly allowPrivateNetwork: boolean;
  private readonly allowedPorts: readonly number[];

  public async adapterFor(
    organizationId: string,
    providerId: string,
  ): Promise<S3ProviderAdapter> {
    const provider = await this.database.providerConnection.findFirst({
      where: { id: providerId, organizationId },
      include: { credential: true },
    });
    if (!provider?.credential) throw new Error("PROVIDER_NOT_FOUND");

    const endpoint = await assertSafeProviderEndpoint(provider.endpoint, {
      allowHttp: this.allowHttp,
      allowPrivateNetwork: this.allowPrivateNetwork,
      allowedPorts: this.allowedPorts,
    });
    const credential = await this.cipher.decrypt(provider.id, {
      algorithm: provider.credential.algorithm as "aes-256-gcm",
      authTag: provider.credential.authTag,
      encryptedDataKey: provider.credential.encryptedDataKey,
      encryptedPayload: provider.credential.encryptedPayload,
      formatVersion: provider.credential.formatVersion as 1,
      iv: provider.credential.iv,
      keyVersion: provider.credential.keyVersion,
    });
    return new S3ProviderAdapter({
      addressingMode: provider.addressingMode,
      credentials: {
        accessKeyId: credential.accessKeyId,
        secretAccessKey: credential.secretAccessKey,
        ...(credential.sessionToken ? { sessionToken: credential.sessionToken } : {}),
      },
      endpoint: endpoint.toString(),
      endpointLookup: createSafeProviderLookup({
        allowPrivateNetwork: this.allowPrivateNetwork,
      }),
      region: provider.region,
    });
  }
}
