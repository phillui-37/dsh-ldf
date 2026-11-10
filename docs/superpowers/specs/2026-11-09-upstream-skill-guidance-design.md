# Upstream skill detection and guidance choice

Date: 2026-11-09

## Intent

Let each DSH plugin detect its corresponding installed upstream skill and let the user choose whether the plugin injects that skill's instructions or its own shorter guidance. This avoids silently duplicating plugin and skill guidance while keeping existing plugin behavior as the default.

## Goals

- Add the same per-plugin boolean setting to `dsh-bugwiki` and `dsh-ldf`: follow the installed upstream skill when enabled; use the plugin's own guidance when disabled.
- Resolve only the expected skill (`bugwiki` or `ldf-check-claim`) from standard user skill roots: `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, and `~/.opencode/skills`.
- Validate the skill's frontmatter name before use. When enabled and found, inject its `SKILL.md` content and omit every prompt section supplied by that plugin, including configured prefix/suffix. When missing or invalid, retain the plugin's existing guidance and configured prefix/suffix, and report the fallback clearly.
- Preserve current behavior by defaulting the setting to off.
- Keep skill discovery independent of LDF model/runtime discovery.

## Approaches

1. **Detect and inject the matching `SKILL.md` (selected):** predictable when the host does not load installed skills automatically, and uses the actual upstream instructions. It costs more prompt tokens. The plugin controls only its own prompt section.
2. **Suppress plugin guidance and rely on DSH's skill loader:** uses fewer tokens, but can leave the session without the skill instructions if DSH has not loaded that skill. Not selected because the requested behavior is to follow the installed skill.
3. **Plugin guidance only:** simplest, but does not satisfy the detection and choice request.

## Constraints and boundaries

- The setting cannot unload or suppress a skill that DSH independently loaded. The UI description must say “Use plugin guidance,” not promise “ignore/unload skill.”
- Detection is read-only and local. Do not install, update, or download skills.
- Search only the user's standard skill roots and the exact expected skill slug; a future custom-path option is out of scope. Read at most 512 KiB per candidate file; larger files are treated as invalid.
- LDF local-model discovery and provisioning are a separate design and must not be coupled to this setting.

## Implementation calls

- Add a boolean setting named `followUpstreamSkill`, default `false`, to each plugin's native settings.
- On enable, check the supported roots for the corresponding exact `SKILL.md`; validate the frontmatter name; inject the matching document only if valid. In skill mode, omit all of that plugin's prompt sections, including configured prefix/suffix. If no valid skill exists, fall back to the plugin's existing guidance and configured prefix/suffix, and emit a concise diagnostic.
- On disable, skip skill-file discovery for prompt selection and retain the existing plugin guidance and configured prefix/suffix.
- Keep tool registration and execution behavior unchanged.

## Open to the builder

Use a concise `console.warn` for the missing/invalid-skill fallback. Do not add a new tool or settings page solely for this status.
