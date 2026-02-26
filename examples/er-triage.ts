import {
  createEvent,
  Event,
  get,
  initializeSimulation,
  initializeStore,
  ProcessDefinition,
  put,
  QueueDiscipline,
  registerProcess,
  registerStore,
  runSimulation,
  scheduleEvent,
  StateData,
} from "../mod.ts";
import { randomIntegerBetween, randomSeeded } from "@std/random";

/**
 * ER triage showcase:
 * - Multiple process definitions and inherited process state
 * - Blocking synchronization with stores (`get`/`put`)
 * - Configurable queue discipline on stores (FIFO/LIFO)
 * - Deterministic run with post-run correctness invariants
 */

const SIM_TIME = 1000;
const URGENT_DOCTORS = 2;
const GENERAL_DOCTORS = 1;

const URGENT_POOL_ID = "er:urgent-pool" as const;
const GENERAL_POOL_ID = "er:general-pool" as const;

type DoctorPool = typeof URGENT_POOL_ID | typeof GENERAL_POOL_ID;
type Urgency = "urgent" | "standard";

interface DoctorToken extends StateData {
  doctorId: string;
  pool: DoctorPool;
}

interface PatientData extends DoctorToken {
  patientId: number;
  urgency: Urgency;
  arrivalAt: number;
  serviceTime: number;
  startAt?: number;
  finishAt?: number;
}

interface ArrivalState extends StateData {
  nextId: number;
}

interface TimelineEvent {
  at: number;
  pool: DoctorPool;
  delta: 1 | -1;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

interface ScenarioStats {
  discipline: QueueDiscipline;
  endedAt: number;
  finished: number;
  urgentFinished: number;
  standardFinished: number;
  urgentP50: number;
  urgentP95: number;
  standardP50: number;
  standardP95: number;
  maxUrgentOccupancy: number;
  maxGeneralOccupancy: number;
}

function printKpiTable(rows: ScenarioStats[]): void {
  const headers = [
    "Discipline",
    "End",
    "Finished",
    "Urgent",
    "Standard",
    "Urgent p50/p95",
    "Standard p50/p95",
    "Max Occ U/G",
  ];
  const body = rows.map((s) => [
    s.discipline,
    String(s.endedAt),
    String(s.finished),
    String(s.urgentFinished),
    String(s.standardFinished),
    `${s.urgentP50}/${s.urgentP95}`,
    `${s.standardP50}/${s.standardP95}`,
    `${s.maxUrgentOccupancy}/${s.maxGeneralOccupancy}`,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...body.map((r) => r[i].length))
  );
  const formatRow = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join(" | ");

  console.log("ER Triage KPI Comparison (general pool discipline)");
  console.log(formatRow(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("-+-"));

  for (const row of body) {
    console.log(formatRow(row));
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Invariant failed: ${msg}`);
}

async function runScenario(
  discipline: QueueDiscipline,
  seed: bigint,
  verbose: boolean = false,
): Promise<ScenarioStats> {
  const prng = randomSeeded(seed);
  const sim = initializeSimulation();

  const urgentPool = initializeStore<DoctorToken, typeof URGENT_POOL_ID>({
    id: URGENT_POOL_ID,
    blocking: false,
    capacity: URGENT_DOCTORS,
    discipline: QueueDiscipline.FIFO,
  });
  const generalPool = initializeStore<DoctorToken, typeof GENERAL_POOL_ID>({
    id: GENERAL_POOL_ID,
    blocking: false,
    capacity: GENERAL_DOCTORS,
    discipline,
  });

  sim.stores = registerStore(sim, urgentPool);
  sim.stores = registerStore(sim, generalPool);

  for (let i = 0; i < URGENT_DOCTORS; i += 1) {
    const token: DoctorToken = {
      doctorId: `U${i + 1}`,
      pool: URGENT_POOL_ID,
    };
    const seedEvent = createEvent<DoctorToken>({
      scheduledAt: 0,
      process: { type: "none", data: token },
    });
    put(sim, seedEvent, urgentPool.id, token);
  }

  for (let i = 0; i < GENERAL_DOCTORS; i += 1) {
    const token: DoctorToken = {
      doctorId: `G${i + 1}`,
      pool: GENERAL_POOL_ID,
    };
    const seedEvent = createEvent<DoctorToken>({
      scheduledAt: 0,
      process: { type: "none", data: token },
    });
    put(sim, seedEvent, generalPool.id, token);
  }

  const patient: ProcessDefinition<{
    arrive: [PatientData, StateData[]];
    waitDoctor: [PatientData, StateData[]];
    treat: [PatientData, StateData[]];
    done: [PatientData, StateData[]];
  }> = {
    type: "patient",
    initial: "arrive",
    steps: {
      arrive(sim, event, state) {
        const { patientId, urgency, pool } = state.data;
        if (verbose) {
          console.log(
            `[${sim.currentTime}] Patient ${patientId} (${urgency}) arrives`,
          );
        }

        const wait = get(sim, event, pool);
        return {
          state: { ...state, step: "waitDoctor" },
          next: [wait.step],
        };
      },
      waitDoctor(sim, event, state) {
        const token = event.process.data as DoctorToken | undefined;
        if (!token?.doctorId) {
          throw new Error(
            `Missing doctor token for patient ${state.data.patientId}`,
          );
        }

        const started = sim.currentTime;
        const updated: PatientData = {
          ...state.data,
          doctorId: token.doctorId,
          startAt: started,
        };
        if (verbose) {
          console.log(
            `[${sim.currentTime}] Patient ${updated.patientId} starts with ${token.doctorId} (${updated.pool})`,
          );
        }

        return {
          state: { ...state, step: "treat", data: updated },
          next: [
            createEvent({
              parent: event.id,
              scheduledAt: sim.currentTime + updated.serviceTime,
              process: {
                ...event.process,
                inheritStep: true,
              },
            }),
          ],
        };
      },
      treat(sim, event, state) {
        const { patientId, doctorId, pool } = state.data;
        if (!doctorId) {
          throw new Error(`Missing doctorId for patient ${patientId}`);
        }

        const finished: PatientData = {
          ...state.data,
          finishAt: sim.currentTime,
        };
        if (verbose) {
          console.log(
            `[${sim.currentTime}] Patient ${patientId} leaves (doctor ${doctorId})`,
          );
        }

        const releaseEvent = createEvent<DoctorToken>({
          parent: event.id,
          scheduledAt: sim.currentTime,
          process: { type: "none" },
        });
        const release = put(sim, releaseEvent, pool, { doctorId, pool });
        return {
          state: { ...state, step: "done", data: finished },
          next: release.resume
            ? [release.step, release.resume]
            : [release.step],
        };
      },
      done(_sim, _event, state) {
        return { state, next: [] };
      },
    },
  };

  const arrivals: ProcessDefinition<{
    run: [ArrivalState, StateData[]];
  }> = {
    type: "arrivals",
    initial: "run",
    steps: {
      run(sim, event, state) {
        const urgency: Urgency = randomIntegerBetween(1, 10, { prng }) <= 3
          ? "urgent"
          : "standard";
        const pool: DoctorPool = urgency === "urgent"
          ? URGENT_POOL_ID
          : GENERAL_POOL_ID;
        const serviceTime = urgency === "urgent"
          ? randomIntegerBetween(10, 18, { prng })
          : randomIntegerBetween(4, 10, { prng });

        const patientData: PatientData = {
          patientId: state.data.nextId,
          urgency,
          arrivalAt: sim.currentTime,
          serviceTime,
          doctorId: "",
          pool,
        };

        const nextId = state.data.nextId + 1;
        const events: Event[] = [
          createEvent({
            scheduledAt: sim.currentTime,
            process: {
              type: "patient",
              data: patientData,
            },
          }),
        ];

        const interArrival = randomIntegerBetween(1, 8, { prng });
        const nextAt = sim.currentTime + interArrival;
        if (nextAt <= SIM_TIME) {
          events.push(
            createEvent({
              parent: event.id,
              scheduledAt: nextAt,
              priority: -1,
              process: {
                type: "arrivals",
                inheritStep: true,
                data: { nextId },
              },
            }),
          );
        }

        return {
          state: { ...state, data: { nextId } },
          next: events,
        };
      },
    },
  };

  sim.registry = registerProcess(sim, patient);
  sim.registry = registerProcess(sim, arrivals);

  const start = createEvent({
    scheduledAt: 0,
    process: {
      type: "arrivals",
      data: { nextId: 1 },
    },
  });
  sim.timeline = scheduleEvent(sim, start);

  const stop = createEvent({ scheduledAt: SIM_TIME });
  sim.timeline = scheduleEvent(sim, stop);

  const [done] = await runSimulation(sim, { untilEvent: stop });

  const latestByPatient = new Map<number, PatientData>();
  for (const processState of Object.values(done.state)) {
    if (processState.type !== "patient") continue;
    const data = processState.data as Partial<PatientData>;
    if (typeof data.patientId !== "number") continue;
    const current = latestByPatient.get(data.patientId);
    if (
      !current ||
      (data.finishAt ?? -Infinity) >= (current.finishAt ?? -Infinity)
    ) {
      latestByPatient.set(data.patientId, data as PatientData);
    }
  }

  const finished = [...latestByPatient.values()].filter((p) =>
    p.finishAt !== undefined
  );
  const urgent = finished.filter((p) => p.urgency === "urgent");
  const standard = finished.filter((p) => p.urgency === "standard");

  const urgentWaits = urgent.map((p) =>
    (p.startAt ?? p.arrivalAt) - p.arrivalAt
  );
  const standardWaits = standard.map((p) =>
    (p.startAt ?? p.arrivalAt) - p.arrivalAt
  );

  for (const p of finished) {
    assert(
      (p.startAt ?? Infinity) >= p.arrivalAt,
      `patient ${p.patientId} starts before arrival`,
    );
    assert(
      (p.finishAt ?? -Infinity) >= (p.startAt ?? Infinity),
      `patient ${p.patientId} finishes before start`,
    );
  }

  const capacityByPool: Record<DoctorPool, number> = {
    [URGENT_POOL_ID]: URGENT_DOCTORS,
    [GENERAL_POOL_ID]: GENERAL_DOCTORS,
  };
  const occupancy: Record<DoctorPool, number> = {
    [URGENT_POOL_ID]: 0,
    [GENERAL_POOL_ID]: 0,
  };
  const maxSeen: Record<DoctorPool, number> = {
    [URGENT_POOL_ID]: 0,
    [GENERAL_POOL_ID]: 0,
  };

  const timeline: TimelineEvent[] = [];
  for (const p of finished) {
    timeline.push({ at: p.startAt!, pool: p.pool, delta: 1 });
    timeline.push({ at: p.finishAt!, pool: p.pool, delta: -1 });
  }

  for (const t of timeline.sort((a, b) => a.at - b.at || a.delta - b.delta)) {
    occupancy[t.pool] += t.delta;
    assert(
      occupancy[t.pool] >= 0,
      `negative occupancy for ${t.pool} at t=${t.at}`,
    );
    assert(
      occupancy[t.pool] <= capacityByPool[t.pool],
      `capacity exceeded for ${t.pool} at t=${t.at}`,
    );
    maxSeen[t.pool] = Math.max(maxSeen[t.pool], occupancy[t.pool]);
  }

  const urgentP95 = percentile(urgentWaits, 95);
  const standardP95 = percentile(standardWaits, 95);
  assert(
    urgentP95 <= standardP95,
    `urgent p95 (${urgentP95}) should be <= standard p95 (${standardP95})`,
  );

  return {
    discipline,
    endedAt: done.currentTime,
    finished: finished.length,
    urgentFinished: urgent.length,
    standardFinished: standard.length,
    urgentP50: percentile(urgentWaits, 50),
    urgentP95,
    standardP50: percentile(standardWaits, 50),
    standardP95,
    maxUrgentOccupancy: maxSeen[URGENT_POOL_ID],
    maxGeneralOccupancy: maxSeen[GENERAL_POOL_ID],
  };
}

if (import.meta.main) {
  const seed = 1n;

  const fifo = await runScenario(QueueDiscipline.FIFO, seed);
  const lifo = await runScenario(QueueDiscipline.LIFO, seed);

  printKpiTable([fifo, lifo]);
}
