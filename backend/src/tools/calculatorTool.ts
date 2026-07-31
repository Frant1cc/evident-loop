type CalculatorArgs = {
  expression?: unknown;
};

export function calculate(args: unknown) {
  const expression = parseExpressionArg(args);
  const value = new ExpressionParser(expression).parse();

  return {
    expression,
    result: value
  };
}

function parseExpressionArg(args: unknown) {
  if (!args || typeof args !== 'object') {
    throw new Error('calculator requires an expression string');
  }

  const { expression } = args as CalculatorArgs;

  if (typeof expression !== 'string' || !expression.trim()) {
    throw new Error('calculator requires an expression string');
  }

  return expression.trim();
}

class ExpressionParser {
  private index = 0;

  constructor(private readonly input: string) {}

  parse() {
    const value = this.parseAdditive();
    this.skipWhitespace();

    if (this.index < this.input.length) {
      throw new Error(`Unexpected token at position ${this.index}`);
    }

    if (!Number.isFinite(value)) {
      throw new Error('Calculation result is not finite');
    }

    return value;
  }

  private parseAdditive(): number {
    let value = this.parseMultiplicative();

    while (true) {
      this.skipWhitespace();
      const operator = this.peek();

      if (operator !== '+' && operator !== '-') return value;

      this.index += 1;
      const right = this.parseMultiplicative();
      value = operator === '+' ? value + right : value - right;
    }
  }

  private parseMultiplicative(): number {
    let value = this.parseUnary();

    while (true) {
      this.skipWhitespace();
      const operator = this.peek();

      if (operator !== '*' && operator !== '/') return value;

      this.index += 1;
      const right = this.parseUnary();

      if (operator === '/' && right === 0) {
        throw new Error('Division by zero');
      }

      value = operator === '*' ? value * right : value / right;
    }
  }

  private parseUnary(): number {
    this.skipWhitespace();
    const operator = this.peek();

    if (operator === '+' || operator === '-') {
      this.index += 1;
      const value = this.parseUnary();
      return operator === '-' ? -value : value;
    }

    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipWhitespace();

    if (this.peek() === '(') {
      this.index += 1;
      const value = this.parseAdditive();
      this.skipWhitespace();

      if (this.peek() !== ')') {
        throw new Error('Missing closing parenthesis');
      }

      this.index += 1;
      return value;
    }

    return this.parseNumber();
  }

  private parseNumber(): number {
    this.skipWhitespace();
    const start = this.index;

    while (/[0-9.]/.test(this.peek())) {
      this.index += 1;
    }

    if (start === this.index) {
      throw new Error(`Expected number at position ${this.index}`);
    }

    const raw = this.input.slice(start, this.index);

    if (!/^\d+(\.\d+)?$|^\.\d+$/.test(raw)) {
      throw new Error(`Invalid number: ${raw}`);
    }

    return Number(raw);
  }

  private skipWhitespace() {
    while (/\s/.test(this.peek())) {
      this.index += 1;
    }
  }

  private peek() {
    return this.input[this.index] ?? '';
  }
}
