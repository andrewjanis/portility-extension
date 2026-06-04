# Portility — Future Enhancements

## Abuse Prevention / Rate Limiting
- **Per-hour rate limit**: Cap uses per rolling hour (e.g., Trial 10/hr, Pro 20/hr, Premium 40/hr, Unlimited 60/hr). Catches sustained automated abuse without impacting normal users.
- **Minimum cooldown between paid API calls**: Enforce delay between calls (e.g., Trial 60s, Pro 30s, Premium 15s, Unlimited 10s). Kills burst abuse from scripts/agents, invisible to humans.
- **Daily cost ceiling**: Track estimated API cost per user per day, soft-block at threshold (e.g., $5/day Pro, $15/day Premium). Directly protects against runaway bills.
- **Concurrent request limit**: Allow only 1 in-flight paid API call per user at a time. Agents parallelize; humans don't.

## Cost Optimization
- **Haiku for /compare**: Structured JSON output task is a good fit for Haiku. Saves ~$60 per 1,000 Second Opinion uses.
- **Combine /second-opinion + /compare into one call**: Reduce from 3 API calls to 2 per Second Opinion. Saves ~$15 per 1,000 uses but increases prompt complexity.
- **Truncate inputs to /compare**: Send ~2K tokens each instead of full brief + full second opinion. Saves ~$10 per 1,000 uses.
