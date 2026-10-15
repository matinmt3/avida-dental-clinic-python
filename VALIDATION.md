# Local validation — 2026-10-15

The prepared Python edition was checked locally with Python 3.12.10 and Node.js 22.23.3.

| Check | Actual result |
| --- | --- |
| `python -X utf8 -m unittest discover -s tests -v` | 12 backend tests passed |
| `node tests/test_frontend.cjs` | 18 frontend regressions passed |
| `node --check` for the five production JavaScript files | Passed |
| First initialization without a shipped database | Created 3 synthetic accounts, 6 services and 4 doctors |
| Repeated initialization | Existing seed rows preserved without duplicate users |
| The three demo credentials documented in README | All three logins returned HTTP 200 |
| Page, deep service route, bootstrap API and local font | All four local HTTP requests returned 200 |

Backend tests use temporary, isolated SQLite files and a loopback server. Frontend tests use Node's built-in modules and a controlled DOM/API harness. The additional startup smoke test used a separate staging database, which was removed afterward. No database or record export is shipped.

These checks do not constitute a full browser matrix, formal accessibility/security audit, production medical-system approval, or working SMS/email integration. No public deployment or hosted GitHub Actions result is claimed. The included CI workflow is configured to run the test commands; it contains no deployment job.

The original running project's files and database were preserved during preparation. Font license and source/hash notices remain in `static/fonts/`.
