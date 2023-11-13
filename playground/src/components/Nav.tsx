import { Link } from "react-router-dom";

export const Navigation = () => {
  return (
    <nav>
      <Link to="/">Basic</Link>
      <Link to="/list">List</Link>
    </nav>
  );
};
