/**
 * The OpenAPI document is generated, and the way it is generated decides what
 * it says. `@nestjs/swagger` reads both the parameter list and the request body
 * out of TypeScript's decorator metadata, and only `tsc` emits that metadata —
 * `tsx` (esbuild) does not.
 *
 * That is not theoretical. `openapi:export` used to run through
 * `tsx src/openapi-export.ts`, so every export wrote a document in which 148
 * operations answered `"parameters": []` and all 13 request bodies were gone,
 * while the server (running `tsc` output) served the document with them. The CI
 * drift gate regenerated with tsx and compared the result against the committed
 * file, so the two agreed on a spec that described neither, and the gap only
 * showed up when the gate ran on an artifact built the other way.
 *
 * These helpers are what turn that trap into a failure: an export of an API
 * that names path parameters and takes bodies, but describes none of them, is
 * refused instead of committed.
 */

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

export interface OpenApiSpecCheck {
  /** Operations in the document: one per method under one path. */
  operations: number;
  /** Parameters the document describes, of every kind. */
  parameters: number;
  /** Operations that carry a request body. */
  bodies: number;
  /** Path parameters the paths ask for, e.g. `{slug}`. */
  pathTokens: number;
  /** `"GET /v1/orgs/{slug}/projects"` for each operation that names a path parameter it does not describe. */
  undocumented: string[];
}

interface OpenApiParameter {
  name?: unknown;
  in?: unknown;
}

function tokensOf(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string);
}

/**
 * True when an export of this API describes no parameter and no request body at
 * all — the signature of a run without decorator metadata. The document is not
 * merely thin, it is empty of arguments, so writing it would replace a real
 * contract with one that cannot be called.
 */
export function argumentsAreMissing(check: OpenApiSpecCheck): boolean {
  return (
    check.operations > 0 &&
    check.pathTokens > 0 &&
    check.parameters === 0 &&
    check.bodies === 0
  );
}

export function checkOpenApiDocument(document: unknown): OpenApiSpecCheck {
  const check: OpenApiSpecCheck = {
    operations: 0,
    parameters: 0,
    bodies: 0,
    pathTokens: 0,
    undocumented: [],
  };
  const paths = (document as { paths?: unknown } | null)?.paths;
  if (!paths || typeof paths !== 'object') return check;

  for (const [path, item] of Object.entries(paths as Record<string, unknown>)) {
    if (!item || typeof item !== 'object') continue;
    const tokens = tokensOf(path);
    for (const method of METHODS) {
      const operation = (item as Record<string, unknown>)[method];
      if (!operation || typeof operation !== 'object') continue;
      check.operations += 1;
      check.pathTokens += tokens.length;

      const raw = (operation as { parameters?: unknown }).parameters;
      const parameters: OpenApiParameter[] = Array.isArray(raw) ? raw : [];
      check.parameters += parameters.length;
      if ((operation as { requestBody?: unknown }).requestBody) check.bodies += 1;

      const described = new Set(
        parameters
          .filter((parameter) => parameter?.in === 'path' && typeof parameter.name === 'string')
          .map((parameter) => parameter.name as string),
      );
      if (tokens.some((token) => !described.has(token))) {
        check.undocumented.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }

  return check;
}
