type Computable<T extends {}> = (state: T) => unknown;
type Computables<T extends {}> = {
  [key: string]: Computable<T>;
} & { [K in keyof T]?: never };
type ComputedState<T extends {}, C extends Computables<T>> = {
  [K in keyof C]: ReturnType<C[K]>;
};

type Action<T extends {}, C extends Computables<T>> = (
  context: { state: T; computed: ComputedState<T, C> },
  ...args: any[]
) => void;
type Actions<T extends {}, C extends Computables<T>> = {
  [key: string]: Action<T, C>;
};
type WrappedActions<A extends Actions<any, any>> = {
  [K in keyof A]: A[K] extends (context: any, ...args: infer P) => infer R ? (...args: P) => R : never;
};

interface StoreOptions<T extends {}, C extends Computables<T>, A extends Actions<T, C>> {
  target: T;
  computables?: C;
  actions?: A;
}

class Store<
  TState extends {},
  TComputables extends Computables<TState>,
  TActions extends Actions<TState, TComputables>,
> {
  state: TState;
  computables = {} as TComputables;
  actions = {} as TActions;

  constructor({ target, computables, actions }: StoreOptions<TState, TComputables, TActions>) {
    this.state = target;
    if (computables) this.computables = computables;
    if (actions) this.actions = actions;
  }
}

const createStore = <T extends {}, C extends Computables<T>, A extends Actions<T, C>>(
  target: T,
  options?: { computed?: C; actions?: A }
): { state: T; actions: WrappedActions<A>; computed: C } => {
  const store = new Store<T, C, A>({
    target: target,
    computables: options?.computed,
    actions: options?.actions,
  });

  const computeState = <T extends {}, C extends Computables<T>>(state: T, computables: C): ComputedState<T, C> => {
    return Object.fromEntries(
      Object.entries(computables).map(([key, computable]) => [key, computable(state)])
    ) as ComputedState<T, C>;
  };

  const wrappedActions = Object.fromEntries(
    Object.entries(store.actions).map(([key, action]) => {
      return [
        key,
        (...args: any[]) => {
          const computed = computeState(store.state, store.computables);
          action({ state: store.state, computed }, ...args);
        },
      ];
    })
  ) as WrappedActions<A>;

  return {
    state: store.state,
    actions: wrappedActions,
    computed: store.computables,
  };
};

const store = createStore(
  { count: 0 },
  {
    computed: {
      double: (state) => state.count * 2,
    },
    actions: {
      increment: ({ state }, step: number) => {
        state.count += step;
      },
    },
  }
);
store.actions.increment(20);
