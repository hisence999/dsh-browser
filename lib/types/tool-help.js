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
export const LAZY_DESCRIPTION = 'Usage is loaded on demand: call browser_help with this tool name.';
function recordOf(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
}
function parameterOf(name, raw, required) {
    const spec = recordOf(raw);
    const type = typeof spec.type === 'string'
        ? spec.type
        : Array.isArray(spec.type) ? spec.type.map(String).join(' | ') : 'any';
    const parameter = { name, type, required };
    if (typeof spec.description === 'string' && spec.description.length > 0)
        parameter.description = spec.description;
    if (Array.isArray(spec.enum) && spec.enum.length > 0)
        parameter.enumValues = spec.enum.map(value => String(value));
    if (spec.default !== undefined) {
        parameter.default = typeof spec.default === 'string' ? spec.default : JSON.stringify(spec.default);
    }
    return parameter;
}
/**
 * Normalize one tool's parameters into renderable rows.
 * @param tool - the registered definition (or the same shape from a wire schema).
 * @returns parameters in declaration order, `required` resolved from the schema.
 */
export function helpParameters(tool) {
    const parameters = recordOf(tool.parameters);
    const properties = recordOf(parameters.properties);
    // `defineTool` always emits `{type:'object', properties:{…}}`, including for a
    // parameter-less tool (`properties: {}`). Treating that as the raw DSL fallback
    // used to surface `type`/`properties` themselves as parameters.
    if (parameters.type === 'object') {
        const required = new Set(Array.isArray(parameters.required) ? parameters.required.map(String) : []);
        return Object.entries(properties).map(([name, spec]) => parameterOf(name, spec, required.has(name)));
    }
    // Raw DSL fallback: `{ name: { type, required, description } }`.
    return Object.entries(parameters).map(([name, spec]) => {
        const raw = recordOf(spec);
        return parameterOf(name, raw, raw.required === true);
    });
}
/** First sentence (or a bounded prefix) of a description, for the catalog. */
export function summarize(description) {
    const line = description.replace(/\s+/g, ' ').trim();
    if (line.length === 0)
        return '(no description)';
    const stop = line.search(/[。！？]|\.\s/);
    const head = stop > 0 ? line.slice(0, stop + 1) : line;
    return head.length <= 120 ? head : `${head.slice(0, 117)}…`;
}
