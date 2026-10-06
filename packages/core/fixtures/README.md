# Fixtures

- `corpus/`: real workflow files from public repositories, fetched 2026-10-06 with the GitHub API, named `<owner>__<repo>__<file>`. Used to prove the YAML editor preserves comments and formatting on real input, and as negative or positive cases for rules. They contain no secrets; public workflows never do.
- `workflows/<rule-slug>/<case>.yml` with `<case>.expected.json` and `<case>.fixed.yml`: snapshot cases per rule, at least one positive, one negative and one with comments and unusual formatting (RULES.md).
