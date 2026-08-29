import assert from "node:assert/strict";
import { test } from "node:test";
import { subscribe } from "statelift";
import { createBenchmarkState } from "./benchmark-state.mjs";

const rowView = (store) => ({
  ids: store.state.data.map((item) => item.id),
  labels: store.state.data.map((item) => item.label),
  selected: store.state.selected,
});

const assertUniqueIds = (ids) => assert.equal(new Set(ids).size, ids.length);

test("benchmark actions are atomic and preserve the full table contract", () => {
  const { actions, store } = createBenchmarkState({ random: () => 0 });
  const deliveries = [];
  const unsubscribe = subscribe(store, () => deliveries.push(rowView(store)));
  const runAction = (action) => {
    deliveries.length = 0;
    action();
    assert.equal(deliveries.length, 1);
    return deliveries[0];
  };

  let view = runAction(actions.run);
  assert.equal(view.ids.length, 1000);
  assertUniqueIds(view.ids);
  assert.equal(view.selected, 0);

  const selectedBeforeReplace = store.state.data[4].id;
  runAction(() => actions.select(selectedBeforeReplace));
  view = runAction(actions.run);
  assert.equal(view.ids.length, 1000);
  assert.ok(view.ids.every((id) => id > selectedBeforeReplace));
  assert.equal(view.selected, 0);

  const labelsBeforeUpdate = [...view.labels];
  view = runAction(actions.update);
  for (let index = 0; index < view.labels.length; index++) {
    assert.equal(
      view.labels[index],
      index % 10 === 0 ? `${labelsBeforeUpdate[index]} !!!` : labelsBeforeUpdate[index],
    );
  }

  const idsBeforeSwap = [...view.ids];
  view = runAction(actions.swapRows);
  const expectedSwap = [...idsBeforeSwap];
  [expectedSwap[1], expectedSwap[998]] = [expectedSwap[998], expectedSwap[1]];
  assert.deepEqual(view.ids, expectedSwap);
  assertUniqueIds(view.ids);

  const idsBeforeAdd = [...view.ids];
  view = runAction(actions.add);
  assert.equal(view.ids.length, 2000);
  assert.deepEqual(view.ids.slice(0, 1000), idsBeforeAdd);
  assertUniqueIds(view.ids);

  const removedId = view.ids[5];
  const idsBeforeRemove = [...view.ids];
  view = runAction(() => actions.remove(removedId));
  assert.deepEqual(view.ids, idsBeforeRemove.filter((id) => id !== removedId));

  const selectedId = view.ids[10];
  view = runAction(() => actions.select(selectedId));
  assert.equal(view.selected, selectedId);

  view = runAction(actions.runLots);
  assert.equal(view.ids.length, 10000);
  assertUniqueIds(view.ids);
  assert.equal(view.selected, 0);

  const selectedBeforeClear = store.state.data[20].id;
  runAction(() => actions.select(selectedBeforeClear));
  view = runAction(actions.clear);
  assert.deepEqual(view.ids, []);
  assert.deepEqual(view.labels, []);
  assert.equal(view.selected, 0);

  unsubscribe();
});
