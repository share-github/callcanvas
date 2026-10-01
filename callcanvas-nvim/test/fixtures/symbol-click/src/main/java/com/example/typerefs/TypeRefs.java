package com.example.typerefs;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class TypeRefs {

    @Tag("make")
    public Shape make(Size size, List<Circle> circles) throws ShapeException {
        Circle c = new Circle(size.w());
        Shape s = (Shape) c;
        if (s instanceof Circle) {
            Registry.register(c);
        }
        int n = Registry.LIMIT + Outer.Inner.Deep.DEPTH;
        Map<String, Outer.Inner> byName = new java.util.HashMap<>();
        com.example.typerefs.Circle full = c;
        Outer.Inner.Deep deep = new Outer.Inner.Deep();
        circles.forEach(Circle::area);
        List<String> names = new ArrayList<>();
        try {
            names.add(String.valueOf(n + byName.size() + full.area() + deep.hashCode()));
        } catch (ShapeException e) {
            throw e;
        }
        Shape anon = new Shape() {
            public double area() { return 0; }
        };
        class Local extends Circle implements Shape {
            Local() { super(1); }
        }
        Kind kind = Kind.ROUND;
        return kind == Kind.SQUARE ? anon : new Local();
    }

    public static <T extends Shape> T same(T shape) {
        return shape;
    }

    public Shape all() {
        var size = new Size(1, 2);
        return same(make(size, new ArrayList<Circle>()));
    }
}
