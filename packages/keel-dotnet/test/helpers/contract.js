// La tabla de rutas que REGISTRA keel-dotnet (ApiRoutes.cs), leída del C# emitido. La usan la paridad del
// contrato y la del OpenAPI derivado.

const ROW = /new\("(\w+)", "(\w+)", "([^"]+)", (\d+), Location: (true|false), Query: \[([^\]]*)\], Body: (null|"\w+"), Handler: (\w+)\.(\w+)\),/g;

/** La tabla ApiRoutes emitida, leída del C#. */
export function dotnetRoutes(files) {
  const file = files.find((f) => f.path.endsWith('/Rest/ApiRoutes.cs'));
  const routes = new Map();
  for (const m of file?.content.matchAll(ROW) ?? []) {
    routes.set(m[1], {
      method: m[2],
      path: m[3],
      status: Number(m[4]),
      location: m[5] === 'true',
      query: [...m[6].matchAll(/"(\w+)"/g)].map((q) => q[1]).sort(),
      body: m[7] === 'null' ? null : m[7].slice(1, -1),
      handler: { className: m[8], method: m[9] }
    });
  }
  return routes;
}

