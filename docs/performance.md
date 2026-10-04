# Performance measurements

Index version 2 was measured on the same Windows x64 / Node.js v24.19.0 corpus
and commit below: 29,763 documents, 68,816 chunks, 216,663,113 source bytes.
Construction took 36.8 seconds; the index occupied 770,473,984 bytes.
The standard 210-sample benchmark measured 7.15 ms uncached median, 40.40 ms p95,
46.99 ms maximum, and 0.0051 ms cached median. Final process RSS was 258 MB.
Snippets now scan original document text for a relevant verbatim window, preserving exact offsets.
A separate cold query adding an absent term to the seven-term employment-law example
exercised OR fallback in 195.7 ms (single sample, not a latency percentile).
These local measurements do not predict production network or concurrent-load latency.
All 11,066 skipped files in this checkout had unsupported extensions.

## Earlier index version 1

Measured locally on Windows x64, Node.js v24.19.0, using upstream commit
`0b950ecd040a26cc672d1eb53ca0933cb3b8ba9f`.

| Measurement | Result |
| --- | --- |
| Indexed text documents | 29,763 |
| Search chunks | 68,816 |
| Indexed source text | 216,663,113 bytes |
| SQLite index | 781,479,936 bytes |
| Index construction | 30.2 seconds, excluding Git download |
| Uncached store latency, median | 4.7 ms |
| Uncached store latency, p95 | 64.6 ms |
| Uncached store latency, maximum | 70.0 ms |
| Cached store latency, median | 0.003 ms |
| Cached store latency, p95 | 0.009 ms |
| Benchmark process RSS | Approximately 81 MB at completion |

The 210 uncached samples use seven queries, including broad terms such as `Vertrag`
and `Datenschutz`. Trailing spaces vary the cache key without changing search semantics;
each query is then repeated immediately to measure the result cache.
The filesystem cache is warm for most samples. This is a sequential in-process measurement,
not an HTTP, cold-start, concurrent-load, or cloud-client benchmark. Results vary by machine and corpus.

The running Docker container was also measured on Linux x64 with Node.js v24.21.0:
29,763 documents, 68,151 chunks, a 775 MB index, 27.2-second index construction,
7.6 ms uncached median and 140.3 ms p95 over the same 210 samples. Cached median was
0.010 ms and p95 0.019 ms; final RSS was approximately 94 MB. Git checkout line-ending
conversion accounts for the Windows/Linux corpus byte and chunk differences.
Docker's first real-corpus MCP search also included cold filesystem reads; do not infer
end-to-end cloud latency from the store benchmark.

Run after building and creating a native index:

```sh
npm run benchmark
```

The first implementation materialized snippets and window ranks for all matching chunks;
its p95 was approximately 639 ms on the same query set. Ranked candidate retrieval and deferred
snippet generation reduced that bottleneck. Search normally examines 128 ranked candidates,
expanding up to 4,096 when duplicates would leave too few distinct documents. Very large documents
can still cause fewer results than requested at that bound.

Index construction temporarily requires storage for both the previous and replacement database.
Queries keep reading the previous snapshot during construction. Memory use during indexing is
higher than this query-only RSS measurement. Deploy one writer per data volume; use separate volumes
for independent replicas. Evaluate concurrent HTTP latency on the deployment hardware before
raising request limits for a large shared installation.
