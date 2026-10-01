package com.example.typerefs;

public final class Registry {
    public static final int LIMIT = 8;

    private Registry() {}

    public static void register(Shape shape) {
        shape.area();
    }
}
