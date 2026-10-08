// A plant of 2,000+ nodes for canvas-at-scale tests (T2.14): one site, 4 workcenters,
// 16 lines, 128 machines (each controlled by its own PLC, which emits 14 signals).
// As ops, so it can be committed through the fake API too.
export function largePlantOps() {
  const ops = [];
  const node = (id, type, label, props = {}) => ops.push({ kind: 'addNode', node: { id, type, label, props } });
  const edge = (from, rel, to) => ops.push({ kind: 'addEdge', edge: { id: `${from}-${rel}-${to}`, from, rel, to } });
  node('site', 'Site', 'Big plant', { location: 'Somewhere' });
  for (let w = 1; w <= 4; w++) {
    const wc = `wc${w}`;
    node(wc, 'Workcenter', `Hall ${w}`);
    edge('site', 'contains', wc);
    for (let l = 1; l <= 4; l++) {
      const line = `${wc}-line${l}`;
      node(line, 'Line', `Hall ${w} line ${l}`);
      edge(wc, 'contains', line);
      for (let m = 1; m <= 8; m++) {
        const machine = `${line}-m${m}`;
        const plc = `${machine}-plc`;
        node(machine, 'Machine', `Press ${w}.${l}.${m}`, { vendor: 'Acme' });
        node(plc, 'PLC', `PLC ${w}.${l}.${m}`, { protocol: 'OPC UA' });
        edge(line, 'contains', machine);
        edge(machine, 'controlledBy', plc);
        for (let s = 1; s <= 14; s++) {
          const signal = `${plc}-s${s}`;
          node(signal, 'Signal', `Signal ${w}.${l}.${m}.${s}`, { unit: '°C' });
          edge(plc, 'emits', signal);
        }
      }
    }
  }
  return ops;
}

export function largePlantGraph() {
  const graph = { nodes: {}, edges: {} };
  for (const op of largePlantOps()) {
    if (op.kind === 'addNode') graph.nodes[op.node.id] = op.node;
    else graph.edges[op.edge.id] = op.edge;
  }
  return graph;
}
