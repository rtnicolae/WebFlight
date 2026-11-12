# FGAddon glider inventory

Source: FGAddon `trunk/Aircraft` (HEAD), crawled 2026-11-12 through the SourceForge web UI
(`https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/<dir>/<file>?format=raw`).
`svn.code.sf.net` and the FlightGear download mirrors are blocked from the build environment.

Method: listed all 679 aircraft folders, fetched every `*-set.xml` (including one level of
`include=` files), and selected gliders by `<tag>glider</tag>`, by description, and by checking
known glider folder names by hand. The flight model comes from `<flight-model>` and the JSBSim
file from `<aero>`.

## JSBSim (`<flight-model>jsb</flight-model>`): in scope

Sailplanes:

| Folder | -set.xml | JSBSim file | Status | Engines | `external_reactions` forces | Model XML | Nasal files |
|---|---|---|---|---|---|---|---|
| ASK13 | `ask13-set.xml` | `ask13.xml` | development | 0 | turn, pull, winch_hitch, aerotow_hitch | `Models/ask13.xml` | 10 |
| ASK21 | `ask21-jsb-set.xml` | `ask21-jsb.xml` (+ `Systems/ask21-aero.xml`, `ask21-fcs`) | production | 0 | turn, pull, winch_hitch, aerotow_hitch | `Models/ask21.xml` | 19 |
| ASK21 | `ask21mi-jsb-set.xml` | `ask21mi-jsb.xml` | production | 1 | turn, pull, winchx/y/z, aerotow_hitch | `Models/ask21.xml` | 21 |
| ASW28 | `ASW28-set.xml` | `ASW28.xml` | early production | 0 | — | `Models/asw28.xml` | 8 |
| ASG29 | `asg29-set.xml` | `asg29.xml` | early production | 0 | turn, pull, winchx/y/z, aerotow_hitch | `Models/asg29.xml` | 13 |
| Arcus | `arcus-set.xml` | `arcus.xml` | — | 0 | — | `Models/Arcus.xml` | 14 |
| Arcus | `arcusm-set.xml` | `arcusm.xml` | — | 1 | — | `Models/ArcusM.xml` | 16 |
| Bergfalke | `bergfalke-ii-set.xml` | `bergfalke-ii.xml` | beta | 0 | — | `Models/bergfalkeii.xml` | 8 |
| DG-101G | `dg101g-set.xml` | `dg101g_jsbsim.xml` | development | 0 | winch/drag x/y/z, winch_hitch, aerotow_hitch | `Models/DG-101G.xml` | 10 |
| DG-300 | `DG-300-set.xml` | `DG-300.xml` | early production | 0 | — | `Models/dg300.xml` | 7 |
| DG-505 | `dg505-set.xml` | `dg505.xml` | early production | 0 | — | `Models/dg505.xml` | 10 |
| DG-1000 | `dg1000s-set.xml` | `DG-1000S.xml` | — | 0 | — | `Models/dg1000.xml` | 11 |
| Ka6 | `ka6-set.xml` | `ka6.xml` | early production | 0 | turn, pull, winch_hitch, aerotow_hitch | `Models/ka6.xml` | 11 |
| LS1-c | `LS1-c-set.xml` | `LS1-c.xml` | early production | 0 | — | `Models/ls1c.xml` | 7 |
| LS4 | `ls4a-set.xml`, `ls4b-set.xml` | `ls4a.xml`, `ls4b.xml` | early production | 0 | — | `Models/ls4.xml` | 10 |
| LS8 | `ls8-sc-neo-set.xml` | `ls8.xml` | early production | 0 | — | `Models/ls8.xml` | 8 |
| LS8 | `ls8-e-neo-set.xml` | `ls8-e.xml` | early production | 1 (FES) | — | `Models/ls8.xml` | 8 |
| Libelle | `H201B-set.xml` | `H201B.xml` | early production | 0 | turn, pull, winch_hitch, aerotow_hitch | `Models/stdlibelle.xml` | 8 |
| miniLAK | `miniLAK-FES-set.xml` | `miniLAK-FES.xml` | early production | 1 (FES) | — | `Models/minilak.xml` | 14 |
| SG38 | `sg38-set.xml` | `sg38.xml` | early production | 0 | turn, pull, hitch | `Models/sg38.xml` | 1 |
| sgs233 | `sgs233-set.xml` | `sgs233.xml` | — | 0 | nose, belly | `Models/sgs233.ac` (no XML) | 0 |
| Taurus | `taurus-electro-g25-set.xml` | `taurus-electro.xml` | production | (system) | — | `Models/taurus.xml` | 14 |
| asw20 | `asw20-JSBSim-set.xml` | `Models/JSBSim/asw20-JSBSim.xml` | beta | 0 | turn, pull, cg_hitch, nose_hitch | `Models/JSBSim/asw20-model.xml` | 15 |
| colditz | `colditz-set.xml` | `colditz.xml` | — | 0 | — | `Models/colditz-model.xml` | 0 |

Other unpowered JSBSim craft (not sailplanes; probably out of scope):
`airwaveXtreme150-JSBSim` (hang glider), `Icaro_MRX13` (hang glider), `paraglider`,
`DerKleineUhu` (model glider), `Parachutist`, `x24b`, `shuttle`.

## YASim: listed only, not ported

| Folder | -set.xml |
|---|---|
| ASK21 | `ask21-set.xml`, `ask21mi-set.xml` |
| ASK21-MI | `ask21-mi-set.xml` |
| Grob-Astir | `astir-set.xml` |
| Grob-G109 | `g109-set.xml` (motor glider) |
| Sky-sportster | `sportster-set.xml` (touring motor glider) |
| bocian | `bocian-set.xml` |
| Airspeed-Horsa, Horsa | `airspeed-horsa-set.xml`, `horsa-set.xml` |
| GAL49-Hamilcar | `hamilcar-set.xml`, `hamilcarX-set.xml` |
| Waco-CG4 | `waco-cg4-set.xml` |

Also UIUC/LaRCsim, not ported: `asw20-v1-nl-uiuc`, `airwaveXtreme150-v1-nl-uiuc`.

## Licenses

Each aircraft's `COPYING` file is checked before that aircraft is bundled, and the result is
recorded in `/LICENSES.md`.
- ASK21: GPL v2 or later (`COPYING`, `README.md`). Authors: Heiko Schulz, Detlef Faber,
  Thomas Polzer, Viktor Radnai, Bea Wolf, Gilberto Agostinho, Herbert Wagner and others.
