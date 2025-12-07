import { memo } from "react";
import { createRoot } from "react-dom/client";
import { createStore, useStore } from "statelift";

let nextId = 1;
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

const random = (max) => Math.round(Math.random() * 1000) % max;

const buildData = (count) => {
  const data = new Array(count);
  for (let i = 0; i < count; i++) {
    data[i] = {
      id: nextId++,
      label: `${adjectives[random(adjectives.length)]} ${colours[random(colours.length)]} ${nouns[random(nouns.length)]}`,
    };
  }
  return data;
};

const store = createStore({
  data: [],
  selected: 0,
});

const actions = {
  run: () => {
    store.state.data = buildData(1000);
    store.state.selected = 0;
  },
  runLots: () => {
    store.state.data = buildData(10000);
    store.state.selected = 0;
  },
  add: () => {
    store.state.data.push(...buildData(1000));
  },
  update: () => {
    const data = store.state.data;
    for (let i = 0, len = data.length; i < len; i += 10) {
      data[i].label += " !!!";
    }
  },
  clear: () => {
    store.state.data = [];
    store.state.selected = 0;
  },
  swapRows: () => {
    const data = store.state.data;
    if (data.length > 998) {
      const tmp = data[1];
      data[1] = data[998];
      data[998] = tmp;
    }
  },
  remove: (id) => {
    const idx = store.state.data.findIndex((d) => d.id === id);
    if (idx !== -1) store.state.data.splice(idx, 1);
  },
  select: (id) => {
    store.state.selected = id;
  },
};

const Row = memo(({ itemId, index }) => {
  const isSelected = useStore(store, (s) => s.selected === itemId);
  const label = useStore(store, (s) => s.data[index]?.label);

  return (
    <tr className={isSelected ? "danger" : ""}>
      <td className="col-md-1">{itemId}</td>
      <td className="col-md-4">
        <a onClick={() => actions.select(itemId)}>{label}</a>
      </td>
      <td className="col-md-1">
        <a onClick={() => actions.remove(itemId)}>
          <span className="glyphicon glyphicon-remove" aria-hidden="true" />
        </a>
      </td>
      <td className="col-md-6" />
    </tr>
  );
});

const Button = ({ id, onClick, title }) => (
  <div className="col-sm-6 smallpad">
    <button type="button" className="btn btn-primary btn-block" id={id} onClick={onClick}>
      {title}
    </button>
  </div>
);

const Jumbotron = memo(
  () => (
    <div className="jumbotron">
      <div className="row">
        <div className="col-md-6">
          <h1>React + Statelift keyed</h1>
        </div>
        <div className="col-md-6">
          <div className="row">
            <Button id="run" title="Create 1,000 rows" onClick={actions.run} />
            <Button id="runlots" title="Create 10,000 rows" onClick={actions.runLots} />
            <Button id="add" title="Append 1,000 rows" onClick={actions.add} />
            <Button id="update" title="Update every 10th row" onClick={actions.update} />
            <Button id="clear" title="Clear" onClick={actions.clear} />
            <Button id="swaprows" title="Swap Rows" onClick={actions.swapRows} />
          </div>
        </div>
      </div>
    </div>
  ),
  () => true,
);

const Main = () => {
  const data = useStore(store, (s) => s.data);

  return (
    <div className="container">
      <Jumbotron />
      <table className="table table-hover table-striped test-data">
        <tbody>
          {data.map((item, index) => (
            <Row key={item.id} itemId={item.id} index={index} />
          ))}
        </tbody>
      </table>
      <span className="preloadicon glyphicon glyphicon-remove" aria-hidden="true" />
    </div>
  );
};

createRoot(document.getElementById("main")).render(<Main />);
