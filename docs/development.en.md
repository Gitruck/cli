# Development and contributions

[Back to README](../README.en.md) · [Command reference](reference.en.md) · [简体中文](development.md)

## Local development

The CLI runtime requires Node.js ≥ 20.6. Source development and builds use Bun.

```bash
git clone https://github.com/Gitruck/cli.git
cd cli
bun install
bun run src/index.ts --help
npm run typecheck
bun run build
```

The public repository supports reading, developing and building the CLI. `test/` and `openspec/` are private submodules requiring maintainer access. Public contributors do not need a recursive clone; authorized maintainers run the complete test suite.

## Repository layout

```text
src/index.ts       Command entry point
src/commands/      CLI commands
src/lib/           Cloud calls, media processing, project assembly and rendering
skills/            Bundled Agent Skills
contracts/         Open project and motion graphics contracts
docs/              Workflow, configuration, command and development references
assets/            README artwork
AGENT.md           Portable agent playbook
```

Add commands through registration functions in `src/commands/` and wire them into `src/index.ts`. Toolbox additions should reuse existing descriptors and runners where applicable. `src/commands/skills.ts` owns the bundled Skill list; see the [reference](reference.en.md) for details.

## Documentation and checks

- README presents the product and onboarding. Maintain parameters, configuration and full explanations in `docs/reference.md` / `docs/reference.en.md`.
- Update both READMEs and corresponding bilingual documents together. Preserve command names, flags, fields and artifact filenames; keep example commands identical.
- Use publicly accessible images or files in `assets/`. Keep examples traceable and large videos out of the npm package.
- Maintainers run `npm test`, which builds and uses Node's test runner. Do not substitute `bun test`. Documentation-only changes should at least run the relevant guards and check links and rendering.
- Check `npm pack --dry-run` when moving bundled documentation so it remains in the package.

## Contributing

Use [Issues](https://github.com/Gitruck/cli/issues) to describe problems, use cases or behavior you would like improved. Explain changes and validation in your PR. Do not include API keys, personal configuration, media paths, generated outputs or private submodule contents.

See [contracts](../contracts/README.md) for interfaces and [AGENT.md](../AGENT.md) for agent usage.
