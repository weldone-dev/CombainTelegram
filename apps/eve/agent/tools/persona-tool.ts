import { defineTool } from 'eve/tools';

import { bindPersonaTool } from '../lib/persona-tool-config';

/**
 * Eve entry point for the deterministic persona engine.
 *
 * The engine is pure TypeScript under `agent/lib/persona/`; this file only
 * attaches its config to `defineTool`, which Eve discovers from the filename
 * (`persona-tool`, exposed to the model under that name).
 */
export default bindPersonaTool(defineTool);
