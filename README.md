# model-catalog

Model catalog data as JSON files, refreshed on a schedule.

```
https://raw.githubusercontent.com/cloudstack-llc/model-catalog/main/v1/prices.json
https://raw.githubusercontent.com/cloudstack-llc/model-catalog/main/v1/ollama-models.json
```

| File | Contents | Source | Cadence |
| --- | --- | --- | --- |
| `v1/prices.json` | Token pricing for hosted models | [models.dev](https://models.dev) | 6 hours |
| `v1/ollama-models.json` | The Ollama library: models, tags, sizes, context windows | [ollama.com](https://ollama.com/library) | 12 hours |

# Token pricing

## Format

Every model with a published input and output rate, in US dollars per one million tokens,
grouped by provider.

```json
"anthropic": {
  "claude-opus-4-5": {"input":5,"output":25,"cache_read":0.5,"cache_write":6.25,"context":200000,"max_output":64000}
}
```

| Field | Meaning |
| --- | --- |
| `input`, `output` | Required. USD per million tokens. |
| `cache_read`, `cache_write` | Prompt-cache rates, when published. |
| `reasoning`, `input_audio`, `output_audio` | Modality-specific rates, when published. |
| `context`, `max_output` | Token limits. |
| `tiers` | Long-context pricing, ascending by `above_context`. Rates replace the base rates once a request's context exceeds that size. |

An absent field means the rate is not published — never zero. Models with no price at all
are omitted rather than published as free.

The envelope carries `schema_version`, `generated_at`, `counts`, and the upstream `etag`
and `sha256`.

`v1/` is versioned on purpose. A breaking schema change ships as `v2/` alongside it.

## Refresh

A scheduled job regenerates the file every six hours and commits it only when the prices
changed, so `git log -p v1/prices.json` shows actual price movement.

A run that finds no priced models, or fewer than 70% of the previous run's, fails without
writing. Individual models that fail validation are dropped rather than repaired. CI
re-serializes the committed file and range-checks every rate.

These are estimates. Providers change prices without notice and negotiated rates differ
from list rates. Bill against your provider's invoice.

## Development

```bash
node --test scripts/*.test.mjs   # transform rules
node scripts/verify.mjs          # validate the committed file, no network
node scripts/generate.mjs        # fetch upstream and rewrite v1/prices.json
```

No dependencies.

Optional `REFRESH_TOKEN` secret: a fine-grained PAT with `contents: write` on this
repository. GitHub disables scheduled workflows after 60 days without repository activity,
and pushes made with the default `GITHUB_TOKEN` do not reset that clock.

## License

MIT (see `LICENSE`). Data derives from models.dev, also MIT — see `NOTICE`.

# Ollama library

`v1/ollama-models.json` — every model in the Ollama library, with its tags,
download sizes, context windows, and per-tag parameter counts and quantization.

```json
{
  "name": "gpt-oss",
  "description": "OpenAI's open-weight models ...",
  "tags": [
    {"tag":"20b","size":"14GB","digest":"17052f91a42e",
     "model_info":{"contextWindow":"128K","parameters":"20.9b","quantization":"MXFP4","arch":"gptoss"}}
  ],
  "params": ["tools","thinking","cloud","20b","120b"],
  "pulls": "11.8M",
  "pulls_approx": 11800000,
  "updated": "1 month ago",
  "updated_at": "2026-07-15T18:02:00Z"
}
```

`name`, `description`, `tags`, `params`, `pulls`, and `updated` are present on every
model. `digest`, `arch`, `pulls_approx`, `updated_at`, `cloud`, `cloud_tags`, and
`model_info.projector` are additions.

**`pulls` and `updated` are true only at `generated_at`.** They are the strings the
site renders, so a file written at midnight still says "1 month ago" the next evening.
`updated_at` carries the absolute timestamp the relative string is derived from, and
`pulls_approx` decodes the display value so it can be sorted — it is a decoded
approximation, not a true count, because no absolute pull count is published anywhere.
Change detection ignores all four.

An unknown context window is `"N/A"`, never an empty string.

Some tags carry an empty `parameters` and `quantization`. Ollama renders no metadata
block at all for certain variants (`-mlx`, `-mxfp8`, `-nvfp4`), so the values do not
exist to be scraped; those tags still carry a real `size` and `contextWindow`. The
count is declared in `counts.missing_model_info` and checked in CI, so a parser
regression cannot hide among them.

**Cloud tags are excluded from `tags[]`.** They host no weights, so they have no size,
parameters, or quantization. A model serving them carries `"cloud": true` and lists them
in `cloud_tags`.

**Vision models keep their projector separate.** The library renders two metadata blocks
for them — the model and its CLIP projector. `model_info` holds the model; the projector
is under `model_info.projector`.

## Source

Ollama publishes no API. Every API-shaped path returns 404, content negotiation is
ignored, and `ollama.com/api/tags` returns hosted cloud models rather than the library.
The catalog is therefore built from server-rendered HTML: one request for the library
index, one per model for its tags, and one per distinct layer digest for the fields that
appear nowhere else.

Parameter counts and quantization are immutable for a layer digest, so they are cached in
`v1/ollama-model-info-cache.json`. A cold run is ~6,500 requests; a warm one is a few
hundred. The crawl runs 8 concurrent with a truthful, contactable user agent.

Because this rests on presentation markup, the generator refuses to publish when a field
drops below 95% coverage, when the catalog shrinks by more than 10%, or when tag names
and scraped parameter counts start disagreeing. On refusal the job fails and the previous
file stands.
