#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
	echo "usage: runtime-feed-publish-bundles.sh <bundle-manifest>..." >&2
	exit 2
fi

temporary="$(mktemp)"
trap 'rm -f "$temporary"' EXIT

for manifest in "$@"; do
	[[ -f "$manifest" ]] || continue
	jq -r '.bundles[] | [.tag, .name, .path, .sha256, (.sizeBytes | tostring)] | @tsv' "$manifest" >> "$temporary"
done

sort -u "$temporary" -o "$temporary"
while IFS=$'\t' read -r tag name path sha256 size_bytes; do
	[[ -n "$tag" ]] || continue
	if ! gh release view "$tag" >/dev/null 2>&1; then
		gh release create "$tag" \
			--target "$GITHUB_SHA" \
			--title "Msty Nexus llama.cpp bundle ${tag#runtime-bundle-llamacpp-}" \
			--notes "Immutable Windows CUDA bundle assembled from digest-pinned upstream llama.cpp release assets." \
			--latest=false
	fi

	remote_digest="$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${tag}" --jq ".assets[] | select(.name == \"${name}\") | .digest")"
	if [[ -z "$remote_digest" ]]; then
		gh release upload "$tag" "$path"
		remote_digest="$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${tag}" --jq ".assets[] | select(.name == \"${name}\") | .digest")"
	fi
	remote_size="$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${tag}" --jq ".assets[] | select(.name == \"${name}\") | .size")"
	if [[ "$remote_digest" != "sha256:${sha256}" || "$remote_size" != "$size_bytes" ]]; then
		echo "published bundle metadata does not match local artifact: ${tag}/${name}" >&2
		exit 1
	fi
done < "$temporary"
