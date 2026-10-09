# Versions and releases (T6.04)

## One version

Tiles has one version, shared by the browser app, the API, the edge agent and the Helm chart. `scripts/version.js` keeps it the same everywhere:

- `package.json` and `package-lock.json`;
- `api/pyproject.toml` and `api/uv.lock`;
- `edge/pyproject.toml`, `edge/uv.lock` and `tiles_edge.__version__`;
- the chart's `version` and `appVersion`.

```sh
npm run version:check                 # every file agrees, and CHANGELOG.md has the version's section
node scripts/version.js set 1.2.0     # writes 1.2.0 everywhere
node scripts/version.js notes 1.2.0   # that version's changelog section: the release notes
```

CI runs the check on every pull request.

## What a version number promises

Versions are [semantic](https://semver.org/spec/v2.0.0.html): `MAJOR.MINOR.PATCH`.

- **Patch** (1.2.**3**): fixes only. Same API, same settings, no migration that changes data.
- **Minor** (1.**3**.0): additions that need nothing from anyone who upgrades:
  - new endpoints, or new optional fields;
  - new settings with defaults;
  - new tables and columns;
  - migrations that keep data and can be rolled back.
- **Major** (**2**.0.0): anything an operator, an integration or an edge agent has to act on:
  - an endpoint or field removed or changed;
  - a setting removed or renamed;
  - a migration that can't be rolled back, or that drops data;
  - a new minimum version of PostgreSQL, TimescaleDB or Kubernetes;
  - the edge agent's protocol changing incompatibly.

Before 1.0.0, minor versions may break things. Their changelog says so under **Changed** or **Removed**.

**Edge agents** upgrade on site and later than the API, so the API must keep accepting agents of the current and the previous minor version. Dropping an older one is a major change.

**Migrations** must apply to a running system and roll back:

- add before removing (expand, then contract in a later release);
- never rewrite a released migration;
- give every migration a `downgrade`.

The upgrade test checks this on every pull request.

## The changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

- **Each pull request** with a change people will notice adds a line under **Unreleased**, in the right group:
  - Added, Changed, Deprecated or Removed;
  - Fixed;
  - Security.
- **Write for the person upgrading:** what changed for them, and what they must do. The task ID helps, for example (T5.15).

## The upgrade test

`scripts/upgrade-test.sh <older ref> <database URL>` proves that an older version's database, with its data, works with this version and can roll back:

1. The older version migrates a new database and makes the demo site.
2. Through its own API, it commits an ontology node, imports 600 readings and uploads a dataset (`scripts/upgrade_check.py write`).
3. This version migrates to head and reads all of that back through its API.
4. This version migrates back down to the older version's revision.
5. The older version reads the data again.

CI's API job runs it from `main` on every pull request, and from the latest release tag once there is one.

## Making a release

1. **Prepare** in a pull request:
   1. Choose the version from what is under **Unreleased** (see above).
   2. Run `node scripts/version.js set X.Y.Z`.
   3. In `CHANGELOG.md`, rename **Unreleased** to `## [X.Y.Z] - YYYY-MM-DD` and start a new empty **Unreleased** above it. Update the links at the end of the file.
   4. Merge it once CI is green.
2. **Tag** the merge commit on `main`, then push the tag:
   ```sh
   git tag -a vX.Y.Z -m "Tiles X.Y.Z"
   git push origin vX.Y.Z
   ```
3. **Automation.** Pushing the tag starts two workflows:
   - The **Release** workflow checks that the tag, the files and the changelog agree. It then publishes a GitHub release with the changelog section as its notes and three files: the Helm chart (`tiles-X.Y.Z.tgz`), the edge agent as one file (`tiles-edge-X.Y.Z.pyz`) and their `SHA256SUMS`.
   - The **Images** workflow publishes `tiles-api`, `tiles-web` and `tiles-edge` tagged `X.Y.Z` and `X.Y`.
4. **Deploy** by pinning the version (`images.api.tag=X.Y.Z`, `images.web.tag=X.Y.Z`) and running `helm upgrade`. The API migrates as it starts. Take a backup first ([backups](runbooks/backups.md)).

**Pre-releases** (`X.Y.Z-rc.1`) follow the same steps and are marked as pre-releases on GitHub.

## Rolling back

If a release has to be undone:

1. **Migrations that ran:** run the new version's `tiles-migrate downgrade <the previous version's revision>`. The upgrade test proves this path for every change. `tiles-migrate current` shows a version's revision; the release notes name a release's new migrations.
2. **Images:** `helm rollback`, or pin the previous image tags.
3. **Data a downgrade can't keep:** if a migration was not reversible (a major release says so), restore the backup taken before the upgrade instead.
