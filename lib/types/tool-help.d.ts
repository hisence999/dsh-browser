/**
 * Model-facing documentation for the deferred (`lazyToolDocs`) tool surface.
 *
 * The tool definitions themselves stay the single source of truth: `browser_help`
 * is rendered from the exact definitions `applyBrowserTools()` registered, not
 * from a second hand-maintained table. That is deliberate — this repository has
 * already paid once for "the docs describe a tool that does not exist / the code
 * has a tool the docs never mention". A separate table would rebuild the same
 * drift under a new name.
 *
 * `defineTool` converts its parameter DSL into JSON Schema (`{type:'object',
 * properties:{…}, required:[…]}`); this module reads that shape and, as a
 * fallback, the raw DSL shape, so the helper keeps working if that conversion
 * ever moves.
 */
/** One-line description the model sees in lazy mode instead of the real prose. */
export declare const LAZY_DESCRIPTION = "Usage is loaded on demand: call browser_help with this tool name.";
/** The definition fields this module reads. Structural on purpose: the host package is a peer. */
export interface HelpTool {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
}
/** One documented parameter, already normalized for rendering. */
export interface HelpParameter {
    name: string;
    type: string;
    required: boolean;
    description?: string;
    enumValues?: string[];
    default?: string;
}
/**
 * Normalize one tool's parameters into renderable rows.
 * @param tool - the registered definition (or the same shape from a wire schema).
 * @returns parameters in declaration order, `required` resolved from the schema.
 */
export declare function helpParameters(tool: HelpTool): HelpParameter[];
/** First sentence (or a bounded prefix) of a description, for the catalog. */
export declare function summarize(description: string): string;
