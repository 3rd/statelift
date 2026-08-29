import { batch, createStore } from "statelift";

const adjectives = [
  "pretty",
  "large",
  "big",
  "small",
  "tall",
  "short",
  "long",
  "handsome",
  "plain",
  "quaint",
  "clean",
  "elegant",
  "easy",
  "angry",
  "crazy",
  "helpful",
  "mushy",
  "odd",
  "unsightly",
  "adorable",
  "important",
  "inexpensive",
  "cheap",
  "expensive",
  "fancy",
];
const colours = [
  "red",
  "yellow",
  "blue",
  "green",
  "pink",
  "brown",
  "purple",
  "brown",
  "white",
  "black",
  "orange",
];
const nouns = [
  "table",
  "chair",
  "house",
  "bbq",
  "desk",
  "car",
  "pony",
  "cookie",
  "sandwich",
  "burger",
  "pizza",
  "mouse",
  "keyboard",
];

export const createBenchmarkState = ({ random = Math.random } = {}) => {
  let nextId = 1;
  const choose = (maximum) => Math.round(random() * 1000) % maximum;
  const buildData = (count) => {
    const data = new Array(count);
    for (let index = 0; index < count; index++) {
      data[index] = {
        id: nextId++,
        label: `${adjectives[choose(adjectives.length)]} ${colours[choose(colours.length)]} ${nouns[choose(nouns.length)]}`,
      };
    }
    return data;
  };

  const store = createStore({
    data: [],
    selected: 0,
  });

  const actions = {
    run: () =>
      batch(store, () => {
        store.state.data = buildData(1000);
        store.state.selected = 0;
      }),
    runLots: () =>
      batch(store, () => {
        store.state.data = buildData(10000);
        store.state.selected = 0;
      }),
    add: () => {
      store.state.data.push(...buildData(1000));
    },
    update: () =>
      batch(store, () => {
        const data = store.state.data;
        for (let index = 0, length = data.length; index < length; index += 10) {
          data[index].label += " !!!";
        }
      }),
    clear: () =>
      batch(store, () => {
        store.state.data = [];
        store.state.selected = 0;
      }),
    swapRows: () => {
      const data = store.state.data;
      if (data.length <= 998) return;
      batch(store, () => {
        const second = data[1];
        data[1] = data[998];
        data[998] = second;
      });
    },
    remove: (id) => {
      const index = store.state.data.findIndex((item) => item.id === id);
      if (index !== -1) store.state.data.splice(index, 1);
    },
    select: (id) => {
      store.state.selected = id;
    },
  };

  return { actions, store };
};
