---
'@mikecx/thunderstorm': minor
---

Add `@STI(typeValue)` for single-table inheritance: subclasses share a base class's table, discriminated by a `type` column the base declares. Built on `@DefaultScope` — a subclass's `all()`/`where()`/`find()` only see its own rows, and querying the base class directly reconstructs each row as its actual subclass rather than always the base. The type value is always an explicit string, never inferred from the class name.
