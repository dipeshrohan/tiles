# Tiles data model and ISA-95

**Task:** T1.19 · **Status:** v1 · **Code:** `NODE_TYPES` in `js/lib/ontology.ts` and `api/src/tiles_api/ontology.py`, the type check in migration `0002`

Tiles describes a plant as an ontology: typed nodes joined by named relationships. This page maps those types to ISA-95 (IEC 62264), the standard most plant IT and MES teams already use. Partners can then read a Tiles ontology in their own terms, and importers (T2.11, T2.13) know where things go.

## Equipment hierarchy

ISA-95 Part 1 describes equipment as a tree, from the company down to the unit that does the work. Tiles follows the same tree with `contains` relationships from parent to child.

| ISA-95 level | Tiles node type | Examples | Required properties |
|---|---|---|---|
| Enterprise | `Enterprise` | the customer company | – |
| Site | `Site` | a plant | `location` |
| Area | `Workcenter` | Electrode, Cell Assembly, Housing Casting | – |
| Work center: production line | `Line` | Cutting Line 1, Die-cast Line 1 | – |
| Work center: process cell, production unit or storage zone | `Cell` | a welding cell, a heat-treatment unit | – |
| Work unit / equipment | `Machine` | Notching Cutter C-01, Die-caster DC-02 | `vendor` |

The type ISA-95 calls Area is named `Workcenter` in Tiles. Existing ontologies, the demo data and the shared parity fixtures already use that name, so it stays; the UI may show "Area" later without changing stored data. ISA-95's own "work center" level is covered by `Line` and `Cell`:
- **`Line`** is a discrete production line: units in sequence, material flowing through.
- **`Cell`** is any other work center:
  - a batch process cell
  - a continuous production unit
  - a storage zone

`Enterprise` and `Cell` were added in v1 (migration `0002`). Both are optional: an ontology that starts at `Site` and has only lines is still valid.

A `Machine` is the ISA-95 work unit. Smaller equipment modules (a spindle, a pump inside a machine) are not separate types yet. Model them as properties of the machine, or as `Machine` nodes contained by it, until a customer needs more.

## Everything else

These types sit beside the hierarchy rather than in it:

| Tiles node type | ISA-95 / plant meaning | Typical relationships |
|---|---|---|
| `Process` | a process segment (Part 2): what a work unit does, e.g. electrode notching | `Machine` `runs` `Process` |
| `Material` | a material definition (Part 2), e.g. anode sheet, AlSi10Mg melt | `Process` `consumes` `Material` |
| `PLC` | the Level 1–2 controller of a machine | `Machine` `controlledBy` `PLC` |
| `Signal` | a process value tag from the control layer (Level 1–2); one time series | `PLC` `emits` `Signal` |
| `Document` | an SOP, manual or drawing | `Document` `describes` any node |
| `Model` | a physics or ML model, e.g. a virtual sensor | `Model` `reads` `Signal`, `Model` `monitors` `Machine` |

Required properties are kept short and are only those the health check can't do without. `PLC` needs `protocol` (OPC UA, Modbus TCP, …) and `Signal` needs `unit`.

## Relationships

| Relationship | From → to | Meaning |
|---|---|---|
| `contains` | parent → child in the equipment hierarchy | ISA-95 hierarchy; every hierarchy node except the top has one parent |
| `runs` | Machine → Process | the machine performs this process segment |
| `consumes` | Process → Material | the process uses this material |
| `controlledBy` | Machine → PLC | the controller that runs the machine |
| `emits` | PLC → Signal | the controller publishes this tag |
| `reads` | Model → Signal | the model takes this signal as input |
| `monitors` | Model → Machine | the model watches this equipment |
| `describes` | Document → any | the document is about this node |
| `feeds` | Line/Cell/Machine → Line/Cell/Machine | material flows from one to the next |

The ontology does not enforce these pairs: any relationship may join any two nodes, and the health check reports structural problems (orphans, dangling and duplicate relationships, missing required properties) rather than modelling rules. Rule checks per relationship are a candidate for the change-approval workflow (T2.12).

## How this maps to other systems

- **MES equipment model:** import the equipment tree level by level, following the mapping table above. Keep the MES equipment ID as a property (`mes_id`) so events from the MES (T3.10) can be joined to nodes.
- **OPC UA:** a server's object tree usually mirrors the equipment hierarchy. Variables become `Signal` nodes, emitted by the `PLC` node for that server.
- **Historian tags:** each tag becomes a `Signal` with `unit`. The tag-to-node suggestions of agentic ingestion (T2.11) use this page to choose the parent machine.
