import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `name:tag@sha256:<64 hex>`: every image is pinned by digest (conventions §9, B-59). */
const PINNED_IMAGE = /^[\w./-]+:[\w.-]+@sha256:[a-f0-9]{64}$/;

interface ComposeImages {
  postgres: string;
  redis: string;
}

/**
 * The image of one top-level compose service: the first `image:` line inside the `<service>:` block (two-space
 * indented key under `services:`). A tiny line scanner instead of a YAML dependency; the shape is fixed by
 * docker-compose.yml and checked by scripts/__tests__/images.test.mjs.
 */
function serviceImage(compose: string, service: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start === -1) throw new Error(`docker-compose.yml has no service "${service}"`);
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}[^\s#]/.test(line)) break; // next service or next top-level key (comments do not end a block)
    const image = /^ {4}image:\s*(\S+)\s*$/.exec(line)?.[1];
    if (image !== undefined) {
      if (!PINNED_IMAGE.test(image)) throw new Error(`docker-compose.yml: ${service} image is not pinned by digest`);
      return image;
    }
  }
  throw new Error(`docker-compose.yml: service "${service}" has no image`);
}

/**
 * The postgres and redis image references Testcontainers starts, read from docker-compose.yml (ADR 0017, ADR 0019
 * §5). One source for both: a Dependabot docker-compose update also reaches the integration tests. Fails fast
 * when the file or a pinned reference is missing.
 */
export function composeImages(
  composeFile = fileURLToPath(new URL('../docker-compose.yml', import.meta.url)),
): ComposeImages {
  const compose = readFileSync(composeFile, 'utf8');
  return { postgres: serviceImage(compose, 'postgres'), redis: serviceImage(compose, 'redis') };
}
