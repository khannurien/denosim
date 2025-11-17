import {
  ProcessDefinition,
  Simulation,
  Event,
  ProcessState,
  StoreID,
  initializeSimulation,
  registerProcess,
  createEvent,
  scheduleEvent,
  initializeStore,
  registerStore,
  get,
  put,
  runSimulation,
} from "../mod.ts";

// ============================================================================
// Configuration
// ============================================================================

const RANDOM_SEED = 42;
const PT_MEAN = 10.0; // Avg processing time in minutes
const PT_SIGMA = 2.0; // Sigma of processing time
const MTTF = 300.0; // Mean time to failure in minutes
const BREAK_MEAN = 1 / MTTF; // Param for exponential distribution
const REPAIR_TIME = 30.0; // Time it takes to repair a machine in minutes
const JOB_DURATION = 30.0; // Duration of other jobs in minutes
const NUM_MACHINES = 10; // Number of machines in the workshop
const WEEKS = 4; // Simulation time in weeks
const SIM_TIME = WEEKS * 7 * 24 * 60; // Simulation time in minutes

// ============================================================================
// Random Number Generation (Seeded)
// ============================================================================

class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  private next(): number {
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }

  exponential(lambda: number): number {
    return -Math.log(1 - this.next()) / lambda;
  }

  normal(mean: number, sigma: number): number {
    const u1 = this.next();
    const u2 = this.next();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + sigma * z0;
  }
}

const rng = new SeededRandom(RANDOM_SEED);

// ============================================================================
// State Data Types
// ============================================================================

interface MachineState {
  machineId: number;
  partsProduced: number;
  breakSignalStore: StoreID;
  repairRequestStore: StoreID;
}

interface BreakMachineState {
  machineId: number;
  breakSignalStore: StoreID;
}

interface RepairmanState {
  repairRequestStore: StoreID;
  currentJob?: {
    jobNumber: number;
    remainingTime: number;
  };
}

interface BreakSignal {
  broken: boolean;
}

interface RepairRequest {
  machineId: number;
}

interface RepairComplete {
  repaired: boolean;
}

// ============================================================================
// Machine Working Process
// ============================================================================

const workingProcess: ProcessDefinition<{
  working: [MachineState, [MachineState]];
  check_break: [MachineState, [MachineState]];
  broken: [MachineState, [MachineState]];
  wait_repair: [MachineState, [MachineState]];
}> = {
  type: "working",
  initial: "working",
  steps: {
    working(sim, event, state) {
      // Produce a part
      const updatedState = {
        ...state,
        data: {
          ...state.data,
          partsProduced: state.data.partsProduced + 1,
        },
      };

      // Schedule next part production
      const processingTime = Math.max(0, rng.normal(PT_MEAN, PT_SIGMA));
      const nextEvent = createEvent(sim, {
        parent: event.id,
        scheduledAt: sim.currentTime + processingTime,
        process: { 
          type: "working", 
          inheritStep: true, 
          data: updatedState.data 
        },
      });

      return {
        state: { ...updatedState, step: "check_break" },
        next: [nextEvent],
      };
    },

    check_break(sim, event, state) {
      // Try to get a break signal (non-blocking)
      const breakCheck = get(sim, event, state.data.breakSignalStore);
      
      // If we got a signal (resume exists), machine is broken
      if (breakCheck.resume) {
        return {
          state: { ...state, step: "broken" },
          next: [breakCheck.step],
        };
      }

      // No break signal, continue working
      const nextEvent = createEvent(sim, {
        parent: event.id,
        scheduledAt: sim.currentTime,
        process: { 
          type: "working", 
          inheritStep: true, 
          data: state.data 
        },
      });

      return {
        state: { ...state, step: "working" },
        next: [nextEvent],
      };
    },

    broken(sim, event, state) {
      // Machine is broken, request repair from repairman
      const repairRequest = put(sim, event, state.data.repairRequestStore, {
        machineId: state.data.machineId,
      } as RepairRequest);

      return {
        state: { ...state, step: "wait_repair" },
        next: [repairRequest.step],
      };
    },

    wait_repair(sim, event, state) {
      // Wait for repair completion
      const repairComplete = get(sim, event, state.data.repairRequestStore);
      
      // When we get the repair complete signal, resume working
      if (repairComplete.resume) {
        const nextEvent = createEvent(sim, {
          parent: event.id,
          scheduledAt: sim.currentTime,
          process: { 
            type: "working", 
            inheritStep: true, 
            data: state.data 
          },
        });

        return {
          state: { ...state, step: "working" },
          next: [nextEvent],
        };
      }

      // Still waiting
      return {
        state,
        next: [repairComplete.step],
      };
    },
  },
};

// ============================================================================
// Machine Break Process
// ============================================================================

const breakMachineProcess: ProcessDefinition<{
  init: [BreakMachineState, [BreakMachineState]];
  schedule_break: [BreakMachineState, [BreakMachineState]];
  send_break: [BreakMachineState, [BreakMachineState]];
}> = {
  type: "break_machine",
  initial: "init",
  steps: {
    init(sim, event, state) {
      // Schedule first breakdown
      const timeToFailure = rng.exponential(BREAK_MEAN);
      
      const nextEvent = createEvent(sim, {
        parent: event.id,
        scheduledAt: sim.currentTime + timeToFailure,
        process: { 
          type: "break_machine", 
          inheritStep: true,
          data: state.data 
        },
      });

      return {
        state: { ...state, step: "schedule_break" },
        next: [nextEvent],
      };
    },

    schedule_break(sim, event, state) {
      // Send break signal to machine
      const breakSignal = put(sim, event, state.data.breakSignalStore, {
        broken: true,
      } as BreakSignal);

      return {
        state: { ...state, step: "send_break" },
        next: [breakSignal.step],
      };
    },

    send_break(sim, event, state) {
      // Schedule next breakdown after sending the current break signal
      const timeToFailure = rng.exponential(BREAK_MEAN);
      const nextBreak = createEvent(sim, {
        parent: event.id,
        scheduledAt: sim.currentTime + timeToFailure,
        process: { 
          type: "break_machine", 
          inheritStep: true,
          data: state.data,
        },
      });

      return {
        state: { ...state, step: "schedule_break" },
        next: [nextBreak],
      };
    },
  },
};

// ============================================================================
// Repairman Process
// ============================================================================

const repairmanProcess: ProcessDefinition<{
  idle: [RepairmanState, [RepairmanState]];
  repairing: [RepairmanState, [RepairmanState]];
  other_job: [RepairmanState, [RepairmanState]];
  check_preempt: [RepairmanState, [RepairmanState]];
}> = {
  type: "repairman",
  initial: "idle",
  steps: {
    idle(sim, event, state) {
      // Check for repair requests (non-blocking)
      const repairCheck = get(sim, event, state.data.repairRequestStore);
      
      if (repairCheck.resume) {
        // There's a repair request - start repairing
        const repairEvent = createEvent(sim, {
          parent: event.id,
          scheduledAt: sim.currentTime,
          process: {
            type: "repairman",
            inheritStep: true,
            data: state.data,
          },
        });

        return {
          state: { ...state, step: "repairing" },
          next: [repairEvent],
        };
      }

      // No repairs, start other job
      const otherJob = createEvent(sim, {
        parent: event.id,
        scheduledAt: sim.currentTime,
        process: {
          type: "repairman",
          inheritStep: true,
          data: {
            ...state.data,
            currentJob: {
              jobNumber: (state.data.currentJob?.jobNumber || 0) + 1,
              remainingTime: JOB_DURATION,
            },
          },
        },
      });

      return {
        state: { ...state, step: "other_job" },
        next: [otherJob],
      };
    },

    repairing(sim, event, state) {
      // Perform repair (takes fixed time)
      const repairDone = createEvent(sim, {
        parent: event.id,
        scheduledAt: sim.currentTime + REPAIR_TIME,
        process: { 
          type: "repairman", 
          inheritStep: true,
          data: state.data 
        },
      });

      // Signal repair complete to the waiting machine
      // We'll use the same store for completion signaling
      const signalComplete = put(sim, repairDone, state.data.repairRequestStore, {
        repaired: true,
      } as RepairComplete);

      // After repair, go back to idle
      const backToIdle = createEvent(sim, {
        parent: signalComplete.step.id,
        scheduledAt: sim.currentTime + REPAIR_TIME,
        process: {
          type: "repairman",
          inheritStep: true,
          data: {
            ...state.data,
            currentJob: state.data.currentJob, // Preserve interrupted job if any
          },
        },
      });

      return {
        state: { ...state, step: "idle" },
        next: [backToIdle],
      };
    },

    other_job(sim, event, state) {
      if (!state.data.currentJob) {
        // No job, go back to idle
        const idleEvent = createEvent(sim, {
          parent: event.id,
          scheduledAt: sim.currentTime,
          process: { 
            type: "repairman", 
            inheritStep: true,
            data: state.data 
          },
        });

        return {
          state: { ...state, step: "idle" },
          next: [idleEvent],
        };
      }

      // Work on other job for a short time, then check for preemption
      const workTime = Math.min(5.0, state.data.currentJob.remainingTime);
      const remainingTime = state.data.currentJob.remainingTime - workTime;
      
      const checkEvent = createEvent(sim, {
        parent: event.id,
        scheduledAt: sim.currentTime + workTime,
        process: {
          type: "repairman",
          inheritStep: true,
          data: {
            ...state.data,
            currentJob: {
              ...state.data.currentJob,
              remainingTime: remainingTime,
            },
          },
        },
      });

      return {
        state: { ...state, step: "check_preempt" },
        next: [checkEvent],
      };
    },

    check_preempt(sim, event, state) {
      // Check if job is complete
      if (state.data.currentJob && state.data.currentJob.remainingTime <= 0) {
        // Job complete, go back to idle
        const idleEvent = createEvent(sim, {
          parent: event.id,
          scheduledAt: sim.currentTime,
          process: {
            type: "repairman",
            inheritStep: true,
            data: {
              ...state.data,
              currentJob: undefined,
            },
          },
        });

        return {
          state: { ...state, step: "idle" },
          next: [idleEvent],
        };
      }

      // Check for repair requests that would preempt this job
      const repairCheck = get(sim, event, state.data.repairRequestStore);
      
      if (repairCheck.resume) {
        // Preempted! Save job state and go repair
        const repairEvent = createEvent(sim, {
          parent: event.id,
          scheduledAt: sim.currentTime,
          process: {
            type: "repairman",
            inheritStep: true,
            data: state.data, // currentJob is preserved for later resumption
          },
        });

        return {
          state: { ...state, step: "repairing" },
          next: [repairEvent],
        };
      }

      // No preemption, continue working on job
      const continueJob = createEvent(sim, {
        parent: event.id,
        scheduledAt: sim.currentTime,
        process: {
          type: "repairman",
          inheritStep: true,
          data: state.data,
        },
      });

      return {
        state: { ...state, step: "other_job" },
        next: [continueJob],
      };
    },
  },
};

// ============================================================================
// Main Simulation Setup
// ============================================================================

function setupSimulation(): Simulation {
  const sim = initializeSimulation();

  // Register processes
  sim.registry = registerProcess(sim, workingProcess);
  sim.registry = registerProcess(sim, breakMachineProcess);
  sim.registry = registerProcess(sim, repairmanProcess);

  // Create shared repair request store
  const repairRequestStore = initializeStore({ 
    capacity: NUM_MACHINES, 
    blocking: false 
  });
  sim.stores = registerStore(sim, repairRequestStore);

  // Start repairman
  const repairmanInit = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "repairman",
      data: { 
        repairRequestStore: repairRequestStore.id,
      } as RepairmanState,
    },
  });
  sim.events = scheduleEvent(sim, repairmanInit);

  // Create machines
  for (let i = 0; i < NUM_MACHINES; i++) {
    // Create break signal store for this machine
    const breakSignalStore = initializeStore({ 
      capacity: 1, 
      blocking: false 
    });
    sim.stores = registerStore(sim, breakSignalStore);

    // Start working process
    const workEvent = createEvent(sim, {
      scheduledAt: 0,
      process: {
        type: "working",
        data: {
          machineId: i,
          partsProduced: 0,
          breakSignalStore: breakSignalStore.id,
          repairRequestStore: repairRequestStore.id,
        } as MachineState,
      },
    });
    sim.events = scheduleEvent(sim, workEvent);

    // Start break process
    const breakEvent = createEvent(sim, {
      scheduledAt: 0,
      process: {
        type: "break_machine",
        data: {
          machineId: i,
          breakSignalStore: breakSignalStore.id,
        } as BreakMachineState,
      },
    });
    sim.events = scheduleEvent(sim, breakEvent);
  }

  return sim;
}

// ============================================================================
// Run Simulation
// ============================================================================

async function main() {
  console.log("Machine Shop Simulation");
  console.log("=======================");
  console.log(`Number of machines: ${NUM_MACHINES}`);
  console.log(`Simulation time: ${WEEKS} weeks (${SIM_TIME} minutes)`);
  console.log(`Mean processing time: ${PT_MEAN} minutes`);
  console.log(`Mean time to failure: ${MTTF} minutes`);
  console.log(`Repair time: ${REPAIR_TIME} minutes`);
  console.log();

  const sim = setupSimulation();
  
  const [states, stats] = await runSimulation(sim, { untilTime: SIM_TIME });
  const finalState = states[states.length - 1];

  console.log();
  console.log("Simulation Results:");
  console.log("===================");
  console.log(`Simulation ended at time: ${stats.end.toFixed(2)} minutes`);
  console.log(`Real execution time: ${stats.duration.toFixed(2)} ms`);
  console.log(`Total events processed: ${finalState.events.length}`);
  console.log();

  // Find the latest state for each machine
  const machineStates = new Map<number, MachineState>();
  
  for (const [eventId, processState] of Object.entries(finalState.state)) {
    if (processState.type === "working") {
      const data = processState.data as MachineState;
      const existing = machineStates.get(data.machineId);
      
      // Keep the state with the highest parts count (latest state)
      if (!existing || data.partsProduced > existing.partsProduced) {
        machineStates.set(data.machineId, data);
      }
    }
  }

  console.log("Machine Production:");
  const sortedMachines = Array.from(machineStates.entries()).sort((a, b) => a[0] - b[0]);
  
  for (const [machineId, state] of sortedMachines) {
    console.log(`  Machine ${machineId}: ${state.partsProduced} parts produced`);
  }

  const totalParts = Array.from(machineStates.values()).reduce(
    (sum, state) => sum + state.partsProduced,
    0
  );
  
  console.log(`\nTotal parts produced: ${totalParts}`);
  console.log(`Average per machine: ${(totalParts / NUM_MACHINES).toFixed(2)}`);
}

main();