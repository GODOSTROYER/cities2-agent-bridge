# Round Rock: grand plan

Written by the coordinator on 13 October 2026 from the whole-map survey (`journals/grand/survey.md`, data in `journals/grand/survey.json`). The owner's brief: a beautiful city on a grand scale, with the feel of New York or London; districts with their own character, not plain grids; great layout and architecture; tourist spots; built on the natural land, water, contours and resources. Expansion is allowed, by this plan only.

Grid used below: tile (col,row), col 0 west to 22 east, row 0 south to 22 north; tile centre x = -6856 + 623.27 col, z = -6856 + 623.27 row.

## The land in one paragraph
A valley 400-650 m high between a western mountain ridge (cols 0-5) and eastern high ground (cols 16-22). One river, about 400 m wide and deep enough for ships, runs south to north through cols 9-13, with ship connections at both map edges. The highway runs down the west side, the railway down the east side. The wind blows to the north-north-east. The present city sits in the middle of the valley (cols 6-15, rows 6-14) on both banks. Large flat land lies open to the south on both banks, to the north-west along the river, and to the east beyond the railway.

## Structure of the city
1. **The river is the spine**, as the Thames is for London. Both banks through the city become public embankments: promenades, parks, squares and landmark sites, never back lots. A bridge about every 700 m through the built-up length; each bridge continues a main street on both sides.
2. **Two grand axes.** The east-west trunk that exists (centre to Hawthorne) becomes the Grand Avenue, continued east to the university and west to the garden suburbs. A new north-south River Drive runs on each bank from the north harbour to the south bank districts.
3. **A ring of green.** The western ridge and the eastern mountains stay natural (nature reserves, forestry on the lower west slopes, a large forest park in the eastern hills with viewpoints). Farming takes the fertile land in the west.
4. **Dirty and noisy uses go north and north-east** (the wind carries their plume away from every home): harbour, freight, clean industry, logistics, the Northgate utility zone. Nothing polluting south or south-west of homes.
5. **Density steps down from the river.** Towers and mixed use by the water and at transit hubs; medium density behind; garden suburbs on the slopes.
6. **Transit before houses.** Every district gets its trunk road links (two or more), a rail-based line (subway, tram or train) and its services and parks before or with its first residents.

## Districts
| # | Name | Tiles (col,row) | Character | Layout idea | Key pieces |
|---|---|---|---|---|---|
| 0 | Old Town (exists) | 8-11, 9-12 | historic centre, civic heart | keep the grid; add a central square where the two axes cross, tree-lined Grand Avenue | city hall when bought, central square, embankment on its river front |
| 1 | Hawthorne (exists) | 12-13, 9-11 | the towers: "Midtown" | keep; finish the civic block and riverside park | subway hub with tram 2 and bus |
| 2 | South Bank | 12-13, 6-8 | the new downtown: offices and high-density homes, the skyline seen across the river | one wide boulevard parallel to the river, a long rectangular central park of about 150 x 500 m in its middle (the Central Park idea), blocks stepped towards the water, a riverside esplanade | subway line 1 extension, a new bridge to the west bank at about row 7, signature office sites on the esplanade |
| 3 | Museum Quay and Marina | 8-10, 15-17 | tourist waterfront: landmarks, plazas, marina, hotels and shops | a crescent boulevard following the bank, a fan of short streets meeting at a waterfront plaza, a pier | landmark and attraction buildings, large park, tram from the centre over the north bridges |
| 4 | University Quarter | 15-16, 12-15 | campus town on quiet flat land | a campus green with the universities around it (a quadrangle), radial streets to a ring, student housing (medium density), bike paths | the universities and college extension, medical university, train stop on the existing line |
| 5 | West Garden Suburbs | 5-8, 3-8 | garden city: low density, curving tree-lined streets that follow the contours, a village green in each neighbourhood | crescents and closes off a curving spine road; no through traffic; 300 m green buffer to the highway | schools and parks in each neighbourhood, tram or bus spine to the centre, new highway interchange |
| 6 | South Promenade and Viewpoints | 8-10, 0-5 | leisure: riverside park, viewpoints on the river hills, sports | a scenic parkway along the bank, viewpoint loops on the hills | large parks, sports parks, attractions |
| 7 | North Harbour and Freight | 11-16, 17-22 | port, logistics and clean industry | harbour basin on the existing seaway, freight spur, industrial grid with wide roads, truck route straight to the north highway exit | cargo harbour (needs the Harbor node), cargo rail, industry zones, own highway interchange |
| 8 | Farm Belt and Forestry | 5-6, 12-14 and 3-6, 8-14 | working countryside | farm lanes on fertile land; forestry tracks on the lower slopes | specialised industry areas |
| 9 | Eastern Forest Park | 14-20, 3-7 | regional park and tourism | a few scenic roads and paths, lodges and viewpoints, no zoning | attractions, large parks |
| 10 | Airport | 3-6, 0-3 | later | flat far south-west | needs the Airport node and its own highway link |

## Order of building
1. **Now:** District 2 South Bank (next to the towers, on flat land, served by extending what exists) and District 3 Museum Quay (the tourist showpiece). Each is planned as a whole first: a build sheet in `journals/grand/district-<n>.md` with the tiles to buy, trunk links and transit first, the street layout as coordinates and road types, zones, service sites, parks and landmark sites.
2. **Next:** District 4 University Quarter; the embankments through Old Town and Hawthorne; the first subway line (centre - Hawthorne - South Bank, later to the university).
3. **Then:** District 5 West Garden Suburbs with its interchange; District 7 North Harbour (moves freight and industry out of the centre: the industry block at (-834,-127) has homes downwind and is retired as the harbour district fills).
4. **Later:** Districts 6, 8, 9, 10.

## Rules for every district
- Buy only the tiles the next sheet needs; tile upkeep rises with every tile owned. Money floors: 20,000,000 in cash and a monthly balance above 2,300,000 at all times.
- No plain uniform grid. Each district has a clear figure: an axis, a square, a crescent, a park, a waterfront. Blocks are regular inside that figure. No dead ends, stubs, slivers or lane drops; junctions on main roads at 150 m or more; no street straight onto a highway; no crossing of water, highway or railway at grade.
- Road types: XL Road Divided for the grand boulevards, Medium Road Divided for district main streets, Small Road for local streets, with trees on all of them; tram tracks or bus lanes on the main street; bike paths along the main streets and to the next district.
- Services ahead of residents, top-tier types, spread across the district (not all in one block): school, clinic or hospital, fire, police, post, welfare, parks so that every home is within reach, garbage and deathcare reach, telecom.
- Mix uses: shops and offices on the main streets and squares, homes behind, so trips are short.
- Follow the ground: main streets along the contours, parks on the awkward ground, viewpoints on the high ground, nothing built in the flood line of the river.
- After each district: happiness must not fall, no factor worse than -2 except Tax, traffic (weighted flow) no worse. Otherwise stop and fix first.
- Record what worked and what did not in `LEARNINGS.md`.

## Status
- 13 October: plan written. Districts 2 and 3 are being drawn up as build sheets.
