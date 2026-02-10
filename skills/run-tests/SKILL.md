---
name: run-tests
description: Run project tests using Maven (mvn). Use when the user asks to run tests.
---

# Run Tests (Maven)

Use Maven (`mvn`) to run tests. Confirm you are in a directory with a `pom.xml` (project root or module root).

## Common commands

### All tests (default)
```bash
mvn test
```

### Specific module (multi-module)
```bash
mvn -pl <module> -am test
```

### Specific test class or method (Surefire)
```bash
mvn -Dtest=MyTest test
mvn -Dtest=MyTest#myMethod test
```

## Steps
1. Ensure you’re in the correct Maven project directory (contains `pom.xml`). If not, ask for the correct path.
2. If the user provides a test name, use `-Dtest=<pattern>` and run `mvn test`.
3. If the user specifies a module, use `-pl <module> -am test`.
4. Otherwise, run `mvn test`.
5. If the command fails, report the error output and ask how they want to proceed.
