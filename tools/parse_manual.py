#!/usr/bin/env python3
"""Build src/library.json (the demo's algorithm library) from the disting NT user manual.

Usage: pdftotext -layout disting_NT_user_manual.pdf manual.txt && python3 tools/parse_manual.py manual.txt src/library.json
"""
import json, re, sys

SRC, OUT = sys.argv[1], sys.argv[2]
lines = open(SRC, encoding='utf-8').read().split('\n')

NUM = re.compile(r'^(-?∞|∞|-?\d+(\.\d+)?(/-?\d+(\.\d+)?)*)$')
UNIT_CODES = {'dB': 2, '%': 3, 'Hz': 4, 'ST': 5, 'semitones': 5, 'cents': 6, 'ms': 7, 's': 8, 'frames': 9,
              'MIDI note': 10, 'kΩ': 11, 'µF': 12, 'V': 13, 'BPM': 14, '°': 15, 'degrees': 15}
extra_units = []

def unit_code(u):
    if not u: return 0
    if u in UNIT_CODES: return UNIT_CODES[u]
    if not re.fullmatch(r'[A-Za-zΩ°µ%/]{1,6}', u): return 0  # stray text, not a unit
    if u not in extra_units: extra_units.append(u)
    return 19 + extra_units.index(u)

def cells(line):
    """Split a layout line into (start, text) cells separated by 2+ spaces."""
    out = []
    for m in re.finditer(r'\S+(?: \S+)*', line):
        out.append((m.start(), m.group()))
    return out

def is_page_noise(l):
    s = l.strip()
    return bool(re.match(r'^Page \d+$', s)) or bool(re.match(r'^\d+ https?://', s))

# ---- find algorithm sections -------------------------------------------------
starts = []
for i, l in enumerate(lines):
    m = re.match(r"^File format guid: '(.{4})'", l.strip())
    if m:
        j = i - 1
        while not lines[j].strip(): j -= 1
        quote = j
        j -= 1
        while not lines[j].strip(): j -= 1
        starts.append((j, i, m.group(1), lines[j].strip()))

end_of_ref = next(i for i, l in enumerate(lines) if l.strip() == 'MIDI SysEx reference' and i > starts[-1][1])

def parse_specs(block):
    text = ' '.join(l.strip() for l in block)
    if re.search(r'Specifications:\s*None', text): return []
    specs = []
    for m in re.finditer(r'●\s*([^●]+?),\s*(-?\d+)\s*-\s*(-?\d+)([^:●]*):', text):
        specs.append({'name': m.group(1).strip(), 'min': int(m.group(2)), 'max': int(m.group(3))})
    return specs

def to_num(s):
    if s in ('-∞',): return None
    try: return float(s)
    except ValueError: return None

def parse_tables(sec):
    """Return [(heading, [row])] where row = dict(name, min, max, def, unit, desc)."""
    tables, cur, row = [], None, None
    blank = False
    for l in sec:
        s = l.strip()
        if not s: blank = True; continue
        if is_page_noise(l): continue
        was_blank, blank = blank, False
        if ' ' not in s and ('=' in s or '://' in s or s.startswith('www')): continue  # wrapped footnote URL
        h = re.match(r'^(?:(.+?) )?[Pp]arameters$', s)
        if h and len(cells(l)) == 1 and not l.startswith('   '):
            cur = {'heading': h.group(1) or 'Parameters', 'rows': []}; tables.append(cur); row = None; continue
        if cur is None: continue
        cs = cells(l)
        if cs and cs[0][1] == 'Name' and any(c[1] == 'Min' for c in cs): continue
        if re.match(r'^(GUI|Description|Specifications|Options|Notes?|Examples?)\b', s) and len(cs) == 1 and cs[0][0] < 3:
            cur = None; row = None; continue
        first_pos, first = cs[0]
        rest = cs[1:]
        words = first.split(' ')
        peeled = []
        while len(words) > 1 and NUM.match(words[-1].replace('−', '-')): peeled.insert(0, words.pop())
        if peeled:
            n_after = 0
            while n_after < len(rest) and NUM.match(rest[n_after][1].replace('−', '-')): n_after += 1
            take = min(len(peeled), 3 - n_after)  # only as many as the row is missing
            if take > 0:
                keep = peeled[:len(peeled) - take]
                first = ' '.join(words + keep); rest = [(first_pos, w) for w in peeled[len(peeled) - take:]] + rest
        nums = []
        k = 0
        while k < len(rest) and NUM.match(rest[k][1].replace('−', '-')): nums.append(rest[k][1].replace('−', '-')); k += 1
        if first_pos <= 3 and not NUM.match(first) and nums:
            unit = ''
            after = rest[k:]
            if after:  # a unit glued to its description with a single space
                for u in sorted(UNIT_CODES, key=len, reverse=True):
                    if after[0][1].startswith(u + ' ') and len(after[0][1]) > len(u) + 3:
                        after = [(after[0][0], u), (after[0][0] + len(u) + 1, after[0][1][len(u) + 1:])] + after[1:]
                        break
            if after and (after[0][1] in UNIT_CODES or (len(after[0][1]) <= 6 and len(after) > 1)):
                unit = after[0][1]; after = after[1:]
            row = {'name': first, 'nums': nums, 'unit': unit, 'desc': ' '.join(c[1] for c in after)}
            cur['rows'].append(row)
        elif row is not None:
            short = len(first) <= 16 and len(first.split()) <= 3 and len(row['name']) <= 24
            if first_pos <= 3 and not NUM.match(first) and short and not was_blank and (not rest or rest[0][0] > 20):
                glue = '' if re.match(r'^[a-z]{1,2}$', first) and re.search(r'[a-z]$', row['name']) and len(row['name'].split()[-1]) > 6 else ' '
                row['name'] += glue + first
                row['desc'] += ' ' + ' '.join(c[1] for c in rest)
            elif first_pos > 20:
                row['desc'] += ' ' + s
            else:
                row = None
                if first_pos <= 3 and len(s) > 30: cur = None  # prose after the table
    return [t for t in tables if t['rows']]

QUOTES = re.compile(r'[“‘"]([^”’"]{1,24})[”’"]')

def build_param(r, idx=None):
    name = r['name']
    if idx is not None: name = re.sub(r'(\d+)-(\d+)', str(idx), name, count=1)
    nums = r['nums']
    vals = []
    for n in nums[:3]:
        if '/' in n:
            parts = n.split('/')
            n = parts[(idx - 1) % len(parts)] if idx else parts[0]
        vals.append(n)
    decimals = max([len(v.split('.')[1]) if '.' in v else 0 for v in vals] + [0])
    f = [to_num(v) for v in vals]
    if len(f) == 1: f = [f[0], None, f[0]]
    elif len(f) == 2: f = [f[0], f[1], f[0]]
    mn, mx, df = f
    if mn is None: mn = -400 / 10 ** decimals if decimals else -40
    if mx is None: mx = 10000 if r['unit'] == 'ms' else mn + 100
    if df is None: df = mn
    scale = 10 ** decimals
    p = {'name': name, 'min': round(mn * scale), 'max': round(mx * scale), 'def': round(df * scale),
         'pow10': -decimals, 'unit': unit_code(r['unit'])}
    p['def'] = max(p['min'], min(p['max'], p['def']))
    count = p['max'] - p['min'] + 1
    lname, desc = name.lower(), r['desc']
    enums = None
    if not r['unit'] and decimals == 0:
        if re.search(r'\b(input|output|bus)\b', lname) and 'mode' not in lname and p['max'] in (28, 64) and 'channel' not in lname:
            enums = (['None'] if p['min'] == 0 else []) + [bus(i) for i in range(max(1, p['min']), p['max'] + 1)]
        elif 'midi channel' in lname and p['min'] == 0 and p['max'] == 16:
            enums = ['None'] + [str(i) for i in range(1, 17)]
        elif 'output mode' in lname or ('add/replace' in desc.lower() and count == 2):
            enums = ['Add', 'Replace']
        else:
            q = [x.strip() for x in QUOTES.findall(desc)]
            seen = []
            for x in q:
                if x not in seen: seen.append(x)
            if len(seen) == count and count > 1: enums = seen
            elif count == 2 and p['min'] == 0 and re.search(r'^(enables?|if (set|enabled)|whether|toggles?)', desc.strip().lower()):
                enums = ['Off', 'On']
    if enums and len(enums) == count:
        p['unit'] = 1; p['enums'] = enums
    return p

def bus(i):
    return f'Input {i}' if i <= 12 else f'Output {i - 12}' if i <= 20 else f'Aux {i - 20}' if i <= 28 else f'Bus {i}'

library = []
for n, (title_i, guid_i, guid, title) in enumerate(starts):
    end = starts[n + 1][0] if n + 1 < len(starts) else end_of_ref
    sec = lines[guid_i + 1:end]
    spec_i = next((k for k, l in enumerate(sec) if l.strip().startswith('Specifications')), None)
    spec_end = next((k for k, l in enumerate(sec) if l.strip() == 'Description'), len(sec))
    specs = parse_specs(sec[spec_i:spec_end]) if spec_i is not None else []
    for sp in specs:
        sp['def'] = sp['min'] if sp['max'] - sp['min'] < 40 else min(sp['max'], max(sp['min'], 2))
    tables = parse_tables(sec)
    pages = []
    for t in tables:
        heading = t['heading']
        rng = re.search(r'(\d+)-(\d+)', heading)
        per = re.match(r'^Per[- ](\w+)', heading)
        if rng:
            a, b = int(rng.group(1)), int(rng.group(2))
            for i in range(a, b + 1):
                pages.append({'name': re.sub(r'\d+-\d+', str(i), heading), 'params': [build_param(r, i) for r in t['rows']]})
        elif per:
            word = per.group(1).lower().rstrip('s')
            sp = next((k for k, s in enumerate(specs) if word in s['name'].lower()), 0 if specs else None)
            pages.append({'name': heading, 'perSpec': sp, 'unit': word.capitalize(), 'params': [build_param(r) for r in t['rows']]})
        else:
            pages.append({'name': heading, 'params': [build_param(r) for r in t['rows']]})
    library.append({'guid': guid, 'name': title, 'specs': specs, 'pages': pages})

units = [''] * 18
for name, code in UNIT_CODES.items():
    if not units[code - 1]: units[code - 1] = name
units[0] = 'enum'
units += extra_units
json.dump({'source': 'disting NT user manual', 'units': units, 'algorithms': library}, open(OUT, 'w'), ensure_ascii=False, indent=0)
print(f'{len(library)} algorithms, {sum(len(p["params"]) for a in library for p in a["pages"])} parameter definitions, extra units {extra_units}')
