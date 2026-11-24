#!/usr/bin/env bash
# Compiles `slack` into standalone Bun executables and packs one release
# archive per target, plus SHA256SUMS, into the output directory.
#
#   scripts/compile-binaries.sh <output dir> [target ...]
#
# Targets default to every supported one: darwin-arm64 darwin-x64 linux-x64 linux-arm64.
# Each archive holds bin/slack beside the files the CLI reads from its
# package root (slack-app-manifest.json, skills/), plus LICENSE and README.md.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <output dir> [target ...]" >&2
  exit 2
fi
out=$1
shift
targets=("$@")
if [[ ${#targets[@]} -eq 0 ]]; then
  targets=(darwin-arm64 darwin-x64 linux-x64 linux-arm64)
fi

root=$(cd "$(dirname "$0")/.." && pwd)
version=$(bun -e "console.log(require('$root/package.json').version)")
mkdir -p "$out"
out=$(cd "$out" && pwd)
staging=$(mktemp -d "$out/.staging.XXXXXX")
trap 'rm -r "$staging"' EXIT

archives=()
for target in "${targets[@]}"; do
  case $target in
    darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64) ;;
    *)
      echo "unsupported target: $target" >&2
      exit 2
      ;;
  esac
  name="slack-$version-$target"
  package="$staging/$name"
  mkdir -p "$package/bin"
  bun build "$root/src/cli.ts" --compile --bytecode --format=esm --minify \
    --target="bun-$target" --outfile "$package/bin/slack"
  cp -R "$root/skills" "$package/skills"
  cp "$root/slack-app-manifest.json" "$root/LICENSE" "$root/README.md" "$package/"
  tar -czf "$out/$name.tar.gz" -C "$staging" "$name"
  archives+=("$name.tar.gz")
done

if command -v sha256sum >/dev/null; then
  (cd "$out" && sha256sum "${archives[@]}" > SHA256SUMS)
else
  (cd "$out" && shasum -a 256 "${archives[@]}" > SHA256SUMS)
fi
echo "Wrote ${archives[*]} and SHA256SUMS to $out"
