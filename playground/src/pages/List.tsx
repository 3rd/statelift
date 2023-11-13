import { createStore, useStore } from "statelift";
import { Navigation } from "../components/Nav";
import { useRenderCount } from "../hooks/useRenderCount";
import { memo } from "react";

type Item = {
  id: number;
  value: string;
};

const store = createStore({
  items: Array.from({ length: 2 }, (_, i) => ({ id: i, value: `Item ${i}` })),
});

const actions = {
  addItems(n: number) {
    let nextId = store.state.items.length;
    store.state.items.push(
      ...Array.from({ length: n }, () => ({
        id: nextId++,
        value: `Item ${nextId}`,
      }))
    );
  },
  updateEveryTenthItem() {
    for (let i = 0; i < store.state.items.length; i += 10) {
      store.state.items[i].value = `${store.state.items[i].value}@`;
    }
  },
};

const Item = memo(({ item }: { item: Item }) => {
  const renderCount = useRenderCount();

  return (
    <li>
      #{item.id} - {item.value} ({renderCount} renders)
    </li>
  );
});

export const List = () => {
  const renderCount = useRenderCount();
  const state = useStore(store);

  return (
    <>
      <Navigation />
      <p>renders: {renderCount}</p>

      <h2>List</h2>

      <button onClick={() => actions.addItems(10_000)}>Add 10000 items</button>
      <button onClick={actions.updateEveryTenthItem}>Update every tenth item</button>

      <ul>
        {state.items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
      </ul>
    </>
  );
};
