import { render, screen } from '@testing-library/react';
import App from './App';

jest.mock('./ClimateMap', () => () => (
  <h1>芝しごと・温量指数気候区分マップ</h1>
));

test('renders climate map title', () => {
  render(<App />);
  expect(screen.getByText(/芝しごと・温量指数気候区分マップ/i)).toBeInTheDocument();
});
