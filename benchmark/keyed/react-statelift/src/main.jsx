import { memo } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "statelift";
import { createBenchmarkState } from "./benchmark-state.mjs";

const { actions, store } = createBenchmarkState();

const Row = memo(({ item, selected }) => {
  const label = useStore(store, () => item.label);

  return (
    <tr className={selected ? "danger" : ""}>
      <td className="col-md-1">{item.id}</td>
      <td className="col-md-4">
        <a onClick={() => actions.select(item.id)}>{label}</a>
      </td>
      <td className="col-md-1">
        <a onClick={() => actions.remove(item.id)}>
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

const RowList = () => {
  const data = useStore(store, (s) => s.data);
  const selected = useStore(store, (s) => s.selected);

  return data.map((item) => (
    <Row key={item.id} item={item} selected={selected === item.id} />
  ));
};

const Main = () => {
  return (
    <div className="container">
      <Jumbotron />
      <table className="table table-hover table-striped test-data">
        <tbody>
          <RowList />
        </tbody>
      </table>
      <span className="preloadicon glyphicon glyphicon-remove" aria-hidden="true" />
    </div>
  );
};

createRoot(document.getElementById("main")).render(<Main />);
