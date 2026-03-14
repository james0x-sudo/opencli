/**
 * Synthesize: turn explore capabilities into ready-to-use CLI definitions.
 *
 * Takes the structured capabilities from Deep Explore and generates
 * YAML pipeline files that can be directly registered as CLI commands.
 *
 * This is the bridge between discovery (explore) and usability (CLI).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

export function synthesizeFromExplore(target: string, opts: any = {}): any {
  const exploreDir = fs.existsSync(target) ? target : path.join('.opencli', 'explore', target);
  if (!fs.existsSync(exploreDir)) throw new Error(`Explore dir not found: ${target}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(exploreDir, 'manifest.json'), 'utf-8'));
  const capabilities = JSON.parse(fs.readFileSync(path.join(exploreDir, 'capabilities.json'), 'utf-8'));
  const endpoints = JSON.parse(fs.readFileSync(path.join(exploreDir, 'endpoints.json'), 'utf-8'));
  const auth = JSON.parse(fs.readFileSync(path.join(exploreDir, 'auth.json'), 'utf-8'));

  const targetDir = opts.outDir ?? path.join(exploreDir, 'candidates');
  fs.mkdirSync(targetDir, { recursive: true });

  const site = manifest.site;
  const topN = opts.top ?? 5;
  const candidates: any[] = [];

  // Sort capabilities by confidence
  const sortedCaps = [...capabilities]
    .sort((a: any, b: any) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, topN);

  for (const cap of sortedCaps) {
    // Find the matching endpoint for more detail
    const endpoint = endpoints.find((ep: any) => ep.pattern === cap.endpoint) ??
                     endpoints[0];

    const candidate = buildCandidateYaml(site, manifest, cap, endpoint);
    const fileName = `${cap.name}.yaml`;
    const filePath = path.join(targetDir, fileName);
    fs.writeFileSync(filePath, yaml.dump(candidate.yaml, { sortKeys: false, lineWidth: 120 }));

    candidates.push({
      name: cap.name,
      path: filePath,
      strategy: cap.strategy,
      endpoint: cap.endpoint,
      confidence: cap.confidence,
      columns: candidate.yaml.columns,
    });
  }

  const index = {
    site,
    target_url: manifest.target_url,
    generated_from: exploreDir,
    candidate_count: candidates.length,
    candidates,
  };
  fs.writeFileSync(path.join(targetDir, 'candidates.json'), JSON.stringify(index, null, 2));

  return {
    site,
    explore_dir: exploreDir,
    out_dir: targetDir,
    candidate_count: candidates.length,
    candidates,
  };
}

/**
 * Build a YAML pipeline definition from a capability + endpoint.
 */
function buildCandidateYaml(site: string, manifest: any, cap: any, endpoint: any): { name: string; yaml: any } {
  const needsBrowser = cap.strategy !== 'public';
  const pipeline: any[] = [];

  // Step 1: Navigate (if browser-based)
  if (needsBrowser) {
    pipeline.push({ navigate: manifest.target_url });
  }

  // Step 2: Fetch the API
  const fetchUrl = endpoint?.url ?? manifest.target_url;
  const fetchStep: any = { url: fetchUrl };

  // If it has search params, template them
  if (cap.recommendedArgs?.some((a: any) => a.name === 'keyword')) {
    try {
      const u = new URL(fetchUrl);
      // Find the search query param and template it
      for (const [k, _v] of u.searchParams) {
        if (['q', 'query', 'keyword', 'search', 'wd', 'kw', 'w', 'search_query'].includes(k)) {
          u.searchParams.set(k, '${{ args.keyword }}');
        }
      }
      fetchStep.url = u.toString().replace(/%24%7B%7B/g, '${{').replace(/%7D%7D/g, '}}');
    } catch {}
  }

  // Add limit param if supported
  if (endpoint?.queryParams?.some((p: string) => ['ps', 'page_size', 'limit', 'count', 'per_page', 'size', 'num'].includes(p))) {
    try {
      const u = new URL(fetchStep.url);
      const limitParam = endpoint.queryParams.find((p: string) => ['ps', 'page_size', 'limit', 'count', 'per_page', 'size', 'num'].includes(p));
      if (limitParam) u.searchParams.set(limitParam, '${{ args.limit | default(20) }}');
      fetchStep.url = u.toString().replace(/%24%7B%7B/g, '${{').replace(/%7D%7D/g, '}}');
    } catch {}
  }

  pipeline.push({ fetch: fetchStep });

  // Step 3: Select the item path
  if (cap.itemPath) {
    pipeline.push({ select: cap.itemPath });
  }

  // Step 4: Map fields to columns
  const mapStep: Record<string, string> = {};
  const columns = cap.recommendedColumns ?? ['title', 'url'];

  // Add a rank column if not doing search
  if (!cap.recommendedArgs?.some((a: any) => a.name === 'keyword')) {
    mapStep['rank'] = '${{ index + 1 }}';
  }

  // Build field mappings from the endpoint's detected fields
  const detectedFields = endpoint?.detectedFields ?? {};
  for (const col of columns) {
    const fieldPath = detectedFields[col];
    if (fieldPath) {
      mapStep[col] = `\${{ item.${fieldPath} }}`;
    } else {
      mapStep[col] = `\${{ item.${col} }}`;
    }
  }

  pipeline.push({ map: mapStep });

  // Step 5: Limit
  pipeline.push({ limit: '${{ args.limit | default(20) }}' });

  // Build args definition
  const argsDef: Record<string, any> = {};
  for (const arg of cap.recommendedArgs ?? []) {
    const def: any = { type: arg.type ?? 'str' };
    if (arg.required) def.required = true;
    if (arg.default != null) def.default = arg.default;
    if (arg.name === 'keyword') def.description = 'Search keyword';
    else if (arg.name === 'limit') def.description = 'Number of items to return';
    else if (arg.name === 'page') def.description = 'Page number';
    argsDef[arg.name] = def;
  }

  // Ensure limit arg always exists
  if (!argsDef['limit']) {
    argsDef['limit'] = { type: 'int', default: 20, description: 'Number of items to return' };
  }

  const allColumns = Object.keys(mapStep);

  return {
    name: cap.name,
    yaml: {
      site,
      name: cap.name,
      description: `${site} ${cap.name} (auto-generated)`,
      domain: manifest.final_url ? new URL(manifest.final_url).hostname : undefined,
      strategy: cap.strategy,
      browser: needsBrowser,
      args: argsDef,
      pipeline,
      columns: allColumns,
    },
  };
}

export function renderSynthesizeSummary(r: any): string {
  const lines = [
    'opencli synthesize: OK',
    `Site: ${r.site}`,
    `Source: ${r.explore_dir}`,
    `Candidates: ${r.candidate_count}`,
  ];
  for (const c of r.candidates ?? []) {
    lines.push(`  • ${c.name} (${c.strategy}, ${(c.confidence * 100).toFixed(0)}% confidence) → ${c.path}`);
  }
  return lines.join('\n');
}
