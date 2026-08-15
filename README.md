# model-prices

LLM token pricing as one JSON file, refreshed from [models.dev](https://models.dev) every
six hours.

```
https://raw.githubusercontent.com/cloudstack-llc/model-prices/main/v1/prices.json
```

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
