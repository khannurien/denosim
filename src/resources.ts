// import { Event, ProcessState, Simulation, StateData } from "./model.ts";

// /**
//  * Utility data structure for inter-process synchronization.
//  * Put/Get operations (see resources.ts) work in a FIFO fashion.
//  * TODO: Move to resources
//  * TODO: Define T more precisely
//  * TODO: T should hold an item of type S
//  */
// export interface Store<T extends StateData = StateData> {
//   /**
//    * Maximum number of items a store can hold at any time.
//    * If a put request is fired and capacity is already reached,
//    * the request will be delayed.
//    */
//   readonly capacity: number;

//   /**
//    * Array of pending get requests in the store.
//    * Earliest requests will be handled first.
//    */
//   getRequests: Event<T>[];

//   /**
//    * Array of pending put requests in the store.
//    * Earliest requests will be handled first.
//    */
//   putRequests: Event<T>[];

//   /**
//    * Array of delayed put requests in the store.
//    * Requests can be delayed because store capacity has been reached,
//    * or because a blocking put request has been fired and is waiting for a get request.
//    * Earliest requests will be handled first.
//    */
//   delayedPutRequests: Event<T>[];
// }

// /**
//  * Creates a new store with:
//  * - Unique ID
//  * - Array of initial items (defaults to an empty array)
//  * - Empty requests arrays (no scheduled get requests)
//  * - Maximum capacity (defaults to 1 item at any time)
//  */
// export function createStore<T>(capacity: number = 1): Store<T> {
//   if (capacity < 0) {
//     throw RangeError(
//       `Store cannot be created with a negative capacity (got ${capacity}).`,
//     );
//   }

//   return {
//     capacity,
//     getRequests: [],
//     putRequests: [],
//     delayedPutRequests: [],
//   };
// }

// /**
//  * Blocking operations that gets an item from a store.
//  * Pops an item from the store if available, returning it immediately.
//  * If there is no item in store, yields control and resumes on the next put operation.
//  * Returns the item that has been put into the request.
//  */
// export function* get<T>(
//   sim: Simulation,
//   event: Event<T>,
//   store: Store<T>,
// ): ProcessState<T> {
//   while (true) {
//     // Fetch delayed put requests first, if any
//     const sourceQueue = store.delayedPutRequests.length > 0
//       ? store.delayedPutRequests
//       : store.putRequests;

//     // Sort put requests in descending order so we can efficiently pop the earliest one
//     const putRequest = sourceQueue.sort((a, b) => b.scheduledAt - a.scheduledAt)
//       .pop();

//     // If a put request was already fired
//     if (putRequest) {
//       // Return the completed request to be rescheduled immediately
//       const updated = { ...putRequest, scheduledAt: sim.currentTime };
//       yield updated;
//       return { sim, event: updated };
//     }

//     // There was no pending put request, store the get request
//     store.getRequests = [...store.getRequests, event];

//     // Yield control
//     return yield;
//   }
// }

// /**
//  * Store operation that makes an item available from a store.
//  * Non-blocking by default; the operation can be configured to be blocked until a
//  * corresponding get request is registered in the store.
//  * If there are pending get requests, handles the earliest one with passed item.
//  * Otherwise, stores the item in a put request for future use.
//  */
// export function* put<T>(
//   sim: Simulation,
//   event: Event<T>,
//   store: Store<T>,
//   item: T,
//   blocking: boolean = false,
// ): ProcessState<T> {
//   // TODO: Refactor to merge put and blockingPut with capacity handling
//   if (
//     blocking ||
//     store.putRequests.length - store.getRequests.length >= store.capacity
//   ) {
//     return yield* blockingPut(sim, event, store, item);
//   }

//   // Sort get requests in descending order so we can efficiently pop the earliest one
//   const getRequest = store.getRequests.sort((a, b) =>
//     b.scheduledAt - a.scheduledAt
//   ).pop();

//   // Either create a new put request or reschedule an existing get request
//   const putRequest = (!getRequest) ? { ...event, item } : {
//     ...getRequest,
//     scheduledAt: sim.currentTime,
//     item,
//   };

//   // There was no pending get request, store the put request
//   if (!getRequest) {
//     store.putRequests = [...store.putRequests, putRequest];
//   }

//   // Yield continuation
//   return yield putRequest;
// }

// /**
//  * Blocking put -- private function, for internal use only.
//  */
// function* blockingPut<T>(
//   sim: Simulation,
//   event: Event<T>,
//   store: Store<T>,
//   item: T,
// ): ProcessState<T> {
//   while (true) {
//     // Sort get requests in descending order so we can efficiently pop the earliest one
//     const getRequest = store.getRequests.sort((a, b) =>
//       b.scheduledAt - a.scheduledAt
//     ).pop();

//     // If a get request was already fired
//     if (getRequest) {
//       // Return the updated request to be rescheduled immediately
//       const updated = { ...getRequest, scheduledAt: sim.currentTime, item };
//       yield updated;
//       return { sim, event: updated };
//     }

//     const putRequest = { ...event, item };
//     // There was no pending get request, store the put request
//     if (store.putRequests.length - store.getRequests.length >= store.capacity) {
//       // Do not exceed store capacity
//       store.delayedPutRequests = [...store.delayedPutRequests, putRequest];
//     } else {
//       store.putRequests = [...store.putRequests, putRequest];
//     }

//     // Yield control
//     return yield;
//   }
// }
