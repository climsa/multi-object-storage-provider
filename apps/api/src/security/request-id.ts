import { randomUUID } from "node:crypto";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export function requestIdFromHeader(candidate: string | undefined): string {
  return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}
