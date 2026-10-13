// La solución .NET del servicio: lo que fija la plataforma (SDK, framework, reglas de compilación y
// versiones de los paquetes) y un proyecto por capa de la arquitectura.
//
// La frontera hexagonal NO es una convención que alguien revisa: son las referencias entre proyectos.
// Domain no referencia nada; Application, solo a Domain; Infrastructure, a Application; Api, a
// Infrastructure. Un `using` de ASP.NET Core en Domain no compila, porque Domain no lo ve. Es mejor red
// que la regla de dependency-cruiser de keel-nest y que la revisión de paquetes de keel-spring.
//
// Lo que cada pieza hace, para quien no conoce .NET:
//   · global.json            fija el SDK (como el wrapper de Gradle) y el runner de pruebas;
//   · Directory.Build.props  las propiedades comunes a todos los proyectos (framework, nulabilidad,
//                            warnings como errores, lockfile de paquetes);
//   · Directory.Packages.props  la versión de cada paquete NuGet, una sola vez para toda la solución;
//   · <Servicio>.slnx        la solución: qué proyectos la forman;
//   · <Proyecto>.csproj      un proyecto: sus referencias y sus paquetes (sin versión: la pone el anterior).

import { DOTNET_SDK_BAND, TARGET_FRAMEWORK, TEST_RUNNER } from '../lib/assets.js';
import { PACKAGES } from '../lib/dotnet-stack.js';
import { solution } from './render.js';

/** Los paquetes que usa ESTA solución (hoy, todos los del esqueleto). */
export function packagesFor() {
  return ['YamlDotNet', 'xunit.v3', 'Microsoft.AspNetCore.Mvc.Testing'];
}

export function generate(model) {
  const sln = solution(model);
  return [
    { path: 'global.json', content: globalJson() },
    { path: 'Directory.Build.props', content: buildProps() },
    { path: 'Directory.Packages.props', content: packagesProps(packagesFor(model)) },
    { path: sln.file, content: slnx(sln) },
    { path: '.gitignore', content: gitignore() },
    { path: sln.domain.csproj, content: csproj({}) },
    { path: sln.application.csproj, content: csproj({ references: [sln.domain], from: sln.application }) },
    {
      path: sln.infrastructure.csproj,
      content: csproj({
        references: [sln.application],
        from: sln.infrastructure,
        // Los tipos de ASP.NET Core (endpoints, ciclo de vida del host) sin ser un proyecto web: el que
        // arranca el servidor es Api.
        frameworks: ['Microsoft.AspNetCore.App'],
        packages: ['YamlDotNet']
      })
    },
    { path: sln.api.csproj, content: apiCsproj(sln) },
    { path: sln.unitTests.csproj, content: testsCsproj(sln) }
  ];
}

function globalJson() {
  return `${JSON.stringify(
    {
      // rollForward latestFeature: cualquier SDK ${DOTNET_SDK_BAND.split('.').slice(0, 2).join('.')}.x igual o posterior, nunca otra versión mayor.
      sdk: { version: DOTNET_SDK_BAND, rollForward: 'latestFeature' },
      // Con el SDK 10, xUnit v3 corre sobre Microsoft.Testing.Platform y `dotnet test` tiene que saberlo.
      test: { runner: TEST_RUNNER }
    },
    null,
    2
  )}\n`;
}

function buildProps() {
  return `<Project>
  <!-- Común a todos los proyectos de la solución. -->
  <PropertyGroup>
    <TargetFramework>${TARGET_FRAMEWORK}</TargetFramework>
    <LangVersion>latest</LangVersion>
    <!-- Tipos de referencia no nulos por defecto: un null sin declarar es un error de compilación. -->
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <!-- Un warning es un error: lo que el compilador avisa no se acumula. -->
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <AnalysisLevel>latest</AnalysisLevel>
    <Deterministic>true</Deterministic>
    <!-- La primera restauración escribe packages.lock.json en cada proyecto: commitéalos, y a partir de
         ahí una restauración en modo bloqueado (la opción locked-mode de dotnet restore) falla si alguien
         cambia una versión sin querer. Un comentario XML no admite dos guiones seguidos: MSBuild
         descartaría este archivo entero, sin decir nada. -->
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
    <!-- Avisa de paquetes con vulnerabilidades conocidas, transitivos incluidos. Se quedan en aviso: un
         CVE publicado mañana no debe impedir compilar hoy, pero tiene que verse. -->
    <NuGetAudit>true</NuGetAudit>
    <NuGetAuditMode>all</NuGetAuditMode>
    <WarningsNotAsErrors>$(WarningsNotAsErrors);NU1901;NU1902;NU1903;NU1904</WarningsNotAsErrors>
  </PropertyGroup>
</Project>
`;
}

function packagesProps(ids) {
  const lines = ids.map((id) => `    <PackageVersion Include="${id}" Version="${PACKAGES[id].version}" />`);
  return `<Project>
  <!-- La versión de cada paquete NuGet, una sola vez: los .csproj los nombran sin versión. Todos con
       licencia permisiva (keel-dotnet lo comprueba al generar). -->
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
${lines.join('\n')}
  </ItemGroup>
</Project>
`;
}

function slnx(sln) {
  const project = (p) => `    <Project Path="${p.csproj}" />`;
  return `<Solution>
  <Folder Name="/src/">
${[sln.domain, sln.application, sln.infrastructure, sln.api].map(project).join('\n')}
  </Folder>
  <Folder Name="/tests/">
${project(sln.unitTests)}
  </Folder>
</Solution>
`;
}

/** La ruta de un .csproj vista desde la carpeta de otro proyecto (los dos cuelgan de la raíz). */
function relative(from, to) {
  const depth = from.dir.split('/').length;
  return `${'../'.repeat(depth)}${to.csproj}`.replaceAll('/', '\\');
}

function csproj({ sdk = 'Microsoft.NET.Sdk', from = null, references = [], frameworks = [], packages = [], properties = [], extra = [] }) {
  const groups = [];
  if (properties.length > 0) groups.push(`  <PropertyGroup>\n${properties.map((line) => `    ${line}`).join('\n')}\n  </PropertyGroup>`);
  if (references.length > 0) {
    groups.push(`  <ItemGroup>\n${references.map((ref) => `    <ProjectReference Include="${relative(from, ref)}" />`).join('\n')}\n  </ItemGroup>`);
  }
  if (frameworks.length > 0) {
    groups.push(`  <ItemGroup>\n${frameworks.map((name) => `    <FrameworkReference Include="${name}" />`).join('\n')}\n  </ItemGroup>`);
  }
  if (packages.length > 0) {
    groups.push(`  <ItemGroup>\n${packages.map((id) => `    <PackageReference Include="${id}" />`).join('\n')}\n  </ItemGroup>`);
  }
  groups.push(...extra);
  return `<Project Sdk="${sdk}">\n${groups.length > 0 ? `\n${groups.join('\n\n')}\n\n` : ''}</Project>\n`;
}

function apiCsproj(sln) {
  return csproj({
    sdk: 'Microsoft.NET.Sdk.Web',
    from: sln.api,
    references: [sln.infrastructure],
    extra: [
      `  <!-- La configuración por perfiles vive en config/ de la raíz del repo, el mismo formato que los otros
       generadores; viaja junto al ejecutable, y la leen también las pruebas, que referencian este proyecto. -->
  <ItemGroup>
    <None Include="..\\..\\config\\**\\*.yaml" LinkBase="config" CopyToOutputDirectory="PreserveNewest" CopyToPublishDirectory="PreserveNewest" />
  </ItemGroup>`
    ]
  });
}

function testsCsproj(sln) {
  return csproj({
    from: sln.unitTests,
    // xUnit v3: el proyecto de pruebas es un ejecutable.
    properties: ['<OutputType>Exe</OutputType>', '<IsPackable>false</IsPackable>'],
    references: [sln.api],
    packages: ['xunit.v3', 'Microsoft.AspNetCore.Mvc.Testing']
  });
}

function gitignore() {
  return `# Salidas de compilación y de pruebas
bin/
obj/
TestResults/
build/

# Editores
.vs/
.idea/
*.user
*.suo
`;
}
