# Inactive pipeline reference

This is a sanitized September 30, 2026 local source snapshot, not an enabled workflow tree. Paths, application names, infrastructure destinations, and schema markers were replaced with examples. Recorded fixtures, application inventories, dependencies, and non-source artifacts were omitted; see `../docs/extraction-manifest.json`.

These controllers document the larger CI/CT/CD design: input ownership, workflow generation, test distribution, product reuse, runner coordination, protected promotion, and platform adapters. They retain application-specific assumptions and may reference omitted application files. Do not copy them into `.github/workflows` without adapting and validating their complete dependency and trust boundaries. Placeholder identities are not working deployment targets.

Only the separately extracted modules in the repository's top-level `ci/src` and new `src` form the supported package. Tests under this reference directory are historical source, not executed package validation. Reference workflows are not linted or executed as release checks.
