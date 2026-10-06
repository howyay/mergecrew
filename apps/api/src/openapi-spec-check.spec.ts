import { argumentsAreMissing, checkOpenApiDocument } from './openapi-spec-check.js';

describe('checkOpenApiDocument', () => {
  it('counts operations, parameters, bodies and path tokens', () => {
    const check = checkOpenApiDocument({
      paths: {
        '/v1/orgs': {
          get: { parameters: [], responses: {} },
          post: { requestBody: { required: true }, responses: {} },
        },
        '/v1/orgs/{slug}/members/{id}': {
          patch: {
            parameters: [
              { name: 'slug', in: 'path' },
              { name: 'id', in: 'path' },
              { name: 'x-request-id', in: 'header' },
            ],
            responses: {},
          },
        },
      },
    });

    expect(check).toEqual({
      operations: 3,
      parameters: 3,
      bodies: 1,
      pathTokens: 2,
      undocumented: [],
    });
  });

  it('lists every operation that names a path parameter it does not describe', () => {
    const check = checkOpenApiDocument({
      paths: {
        '/v1/orgs/{slug}': { get: { parameters: [] }, patch: { parameters: [] } },
        '/v1/orgs/{slug}/members/{id}': { delete: { parameters: [] } },
      },
    });

    expect(check.operations).toBe(3);
    expect(check.pathTokens).toBe(4);
    expect(check.undocumented).toEqual([
      'GET /v1/orgs/{slug}',
      'PATCH /v1/orgs/{slug}',
      'DELETE /v1/orgs/{slug}/members/{id}',
    ]);
  });

  it('does not accept a query or header parameter standing in for a path one', () => {
    const check = checkOpenApiDocument({
      paths: {
        '/v1/orgs/{slug}': {
          get: { parameters: [{ name: 'slug', in: 'query' }] },
        },
      },
    });

    expect(check.parameters).toBe(1);
    expect(check.undocumented).toEqual(['GET /v1/orgs/{slug}']);
  });

  it('is quiet about a path with no parameters at all', () => {
    const check = checkOpenApiDocument({
      paths: { '/v1/healthz': { get: { responses: {} } } },
    });

    expect(check).toEqual({
      operations: 1,
      parameters: 0,
      bodies: 0,
      pathTokens: 0,
      undocumented: [],
    });
  });

  it('answers for a document that has no paths', () => {
    const empty = { operations: 0, parameters: 0, bodies: 0, pathTokens: 0, undocumented: [] };
    expect(checkOpenApiDocument({})).toEqual(empty);
    expect(checkOpenApiDocument(null)).toEqual(empty);
    expect(checkOpenApiDocument({ paths: 'nonsense' })).toEqual(empty);
  });
});

describe('argumentsAreMissing', () => {
  it('catches the document an export without decorator metadata writes', () => {
    // What `tsx src/openapi-export.ts` produced: the paths ask for parameters,
    // and every operation answers `"parameters": []` with no request body.
    const check = checkOpenApiDocument({
      paths: {
        '/v1/orgs/{slug}/projects': { get: { parameters: [] }, post: { parameters: [] } },
        '/v1/orgs/{slug}/ideas/{ideaId}/decision': {
          post: { parameters: [] },
        },
      },
    });

    expect(argumentsAreMissing(check)).toBe(true);
  });

  it('passes a document that describes at least the bodies it accepts', () => {
    const check = checkOpenApiDocument({
      paths: {
        '/v1/orgs/{slug}/projects': {
          get: { parameters: [] },
          post: { parameters: [], requestBody: { required: true } },
        },
      },
    });

    expect(argumentsAreMissing(check)).toBe(false);
  });

  it('passes a document that describes at least one parameter', () => {
    const check = checkOpenApiDocument({
      paths: {
        '/v1/orgs/{slug}': { get: { parameters: [{ name: 'slug', in: 'path' }] } },
      },
    });

    expect(argumentsAreMissing(check)).toBe(false);
  });

  it('does not fire for a document with no operations or no path parameters', () => {
    expect(argumentsAreMissing(checkOpenApiDocument({}))).toBe(false);
    expect(
      argumentsAreMissing(checkOpenApiDocument({ paths: { '/v1/healthz': { get: {} } } })),
    ).toBe(false);
  });
});
