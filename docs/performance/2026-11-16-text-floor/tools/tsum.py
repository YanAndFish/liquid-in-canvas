import json, sys, collections
ev = json.load(open(sys.argv[1]))
names = {}
for e in ev:
    if e.get('ph') == 'M' and e.get('name') == 'thread_name':
        names[(e['pid'], e['tid'])] = e['args']['name']
    if e.get('ph') == 'M' and e.get('name') == 'process_name':
        names[(e['pid'], None)] = e['args']['name']
ts = [e['ts'] for e in ev if 'ts' in e and e.get('ph') in ('X','B')]
span = (max(ts) - min(ts)) / 1e3 if ts else 1
by = collections.defaultdict(list)
for e in ev:
    if e.get('ph') == 'X' and 'dur' in e:
        by[(e['pid'], e['tid'])].append(e)
rows = []
for key, es in by.items():
    es.sort(key=lambda e: (e['ts'], -e['dur']))
    end = -1; total = 0; agg = collections.Counter(); cnt = collections.Counter()
    for e in es:
        if e['ts'] >= end:
            total += e['dur']; agg[e['name']] += e['dur']; cnt[e['name']] += 1; end = e['ts'] + e['dur']
    proc = names.get((key[0], None), '?'); th = names.get(key, str(key[1]))
    rows.append((total, proc, th, agg, cnt))
rows.sort(key=lambda r: -r[0])
print(f'span {span:.0f} ms')
for total, proc, th, agg, cnt in rows[:8]:
    print(f'{proc:>12} / {th:<28} busy {total/1e3:7.1f} ms ({total/1e3/span*100:4.1f}%)')
    for n, d in agg.most_common(6):
        print(f'      {d/1e3:7.1f} ms  x{cnt[n]:<4} {n}')
for n in ['DrawFrame', 'BeginFrame', 'Graphics.Pipeline', 'PaintEvent']:
    c = sum(1 for e in ev if e.get('name') == n)
    if c: print(n, c)
