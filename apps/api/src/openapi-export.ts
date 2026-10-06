import 'reflect-metadata';
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { buildOpenApiDocumentConfig } from './openapi-config.js';
import { checkOpenApiDocument, argumentsAreMissing } from './openapi-spec-check.js';

/**
 * Boots the Nest app graph (no listen) and writes the OpenAPI JSON to
 * docs/openapi.json so SDK generators and external API consumers can pick
 * up the spec without spinning up the full API. Runs in CI to detect drift.
 *
 * It has to run the compiled app (`node dist/openapi-export.js`, which is what
 * `pnpm --filter @mergecrew/api openapi:export` does): `@nestjs/swagger` reads
 * the parameter list from TypeScript's decorator metadata, and `tsx` does not
 * emit it, so running this file through tsx writes a document that describes
 * none of the path parameters. The check below refuses to write that document.
 */
async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  const doc = SwaggerModule.createDocument(app, buildOpenApiDocumentConfig());

  const check = checkOpenApiDocument(doc);
  if (argumentsAreMissing(check)) {
    console.error(
      `[openapi-export] refusing to write a document with no arguments: ${check.operations} ` +
        `operation(s) across ${check.pathTokens} path parameter(s), not one parameter and not one ` +
        'request body described',
    );
    console.error(
      '[openapi-export] @nestjs/swagger reads both out of TypeScript decorator metadata, which tsx ' +
        'does not emit. Run the compiled app instead: ' +
        'pnpm --filter @mergecrew/api openapi:export',
    );
    await app.close();
    process.exit(1);
  }
  if (check.undocumented.length > 0) {
    console.warn(
      `[openapi-export] note: ${check.undocumented.length} of ${check.operations} operation(s) name a ` +
        `path parameter the document does not describe, starting with ${check.undocumented[0]} — ` +
        'a controller that reads the org slug with its own decorator needs @ApiParam to describe it',
    );
  }

  // Running the built app puts __dirname in apps/api/dist; from source it is
  // apps/api/src. Either way the repo root is three levels up.
  const repoRoot = resolve(__dirname, '../../..');
  const outPath = resolve(repoRoot, 'docs/openapi.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');

  await app.close();
  console.log(
    `[openapi-export] wrote ${outPath} (${check.operations} operations, ` +
      `${check.parameters} parameters, ${check.bodies} request bodies)`,
  );
}

main().catch((err) => {
  console.error('[openapi-export] failed', err);
  process.exit(1);
});
