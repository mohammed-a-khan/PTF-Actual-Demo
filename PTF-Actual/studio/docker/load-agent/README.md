# Load generator image

`cs-test-studio agent` in a container, so load generators can run where the users are (other regions, branch
offices, a cloud subscription) and be started on demand.

1. `npm pack` in the Studio's folder, and copy the `.tgz` here as `cs-test-studio.tgz`.
2. `docker build -t cs-load-agent docker/load-agent`
3. `docker run -d -p 4720:4720 -e CS_AGENT_TOKEN=<secret> -e ZONE=eu-west cs-load-agent`
4. In the scenario (Performance → the scenario → Load generators), add `http(s)://<host>:4720`, its zone and the
   token as `{env:LOADGEN_TOKEN}` (the secret itself stays in the Studio's secret store or the pipeline).

The parts a generator receives carry the scenario's values, secrets included: run generators on a private network,
or give the agent a certificate (`--tls-cert`, `--tls-key`, mounted into the container).
