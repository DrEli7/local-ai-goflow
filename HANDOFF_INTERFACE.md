# Public handoff presentation feature

Add a complete, independently usable pure-data feature for the public plugin.

Public interface: `export function handoffMetadata(status, route)` from `src/handoff-metadata.mjs`.
Return exactly `{ executionBackend, splitRequired, nextAction }`.

- `executionBackend` preserves only the known status values `opencode` and `deepseek-harness`; missing or unknown values become null.
- `splitRequired` is true only when `route.executor` is `gpt` and `route.splitRequired` is the boolean true. Legacy responses without it yield false.
- If a split is required, `nextAction` is the fixed public instruction `GPT must keep the critical core and route independent ordinary feature packages through GoFlow`.
- Otherwise `nextAction` is the existing fixed instruction `GPT should use existing GoFlow tools only for authorized bounded code tasks`.
- Missing, null, primitive and array inputs use safe defaults, without mutating inputs. Do not copy arbitrary input fields or raw action/reason strings into the output. The module is presentation only; it never grants permission or changes routing.
- No dependencies, I/O, filesystem, process, network, shell or dynamic execution. ES modules, Node built-in unit tests.

Go owns the implementation and the complete `tests/handoff-metadata.test.mjs`. GPT will integrate the module into the separately maintained bridge after reviewing the actual delivery. No other files may be edited.
