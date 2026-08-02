import { describe, expect, it } from "vitest";

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
