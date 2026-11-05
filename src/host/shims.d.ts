/**
 * Ambient declarations for the DSH host packages this plugin links against.
 *
 * The host half is never bundled: at runtime these specifiers resolve inside the
 * running DeepSeek Harness installation, so only the shapes this plugin actually
 * touches are declared here. Keep this file in sync with the real packages when a
 * new call is added — it is a type-check aid, not a runtime shim.
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  export function Remote(name: string): any
  export class TypertRemoteService<T = never> {
    constructor(ctx: any, name: string)
    protected readonly ctx: any
    dispose?(): void | Promise<void>
  }
}

declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(options: any): any
}

declare module '@deepseek-ai/schemastery' {
  const Schema: any
  export default Schema
}
