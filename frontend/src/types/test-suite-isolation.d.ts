// Test suites import a module with a query suffix to get an isolated instance:
// bun shares one module registry across the whole test run, so module-level
// state (frame scopes, viewer registries) would otherwise leak between suites.
// TypeScript resolves specifiers literally, so declare the suffixed form here.
declare module '*?suite=overlay' {
  const surface: any
  export = surface
}
