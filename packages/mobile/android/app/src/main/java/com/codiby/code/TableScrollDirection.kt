package com.codiby.code

import kotlin.math.abs

/** Tolerates initial finger wobble, then keeps the chosen axis until the next touch. */
internal class TableScrollDirection(private val horizontalSlop: Float, private val verticalSlop: Float) {
    enum class Axis { PENDING, HORIZONTAL, VERTICAL }
    var axis = Axis.PENDING
        private set
    private var startX = 0f
    private var startY = 0f

    fun start(x: Float, y: Float) {
        startX = x
        startY = y
        axis = Axis.PENDING
    }

    fun move(x: Float, y: Float): Axis {
        if (axis == Axis.PENDING) {
            val dx = abs(x - startX)
            val dy = abs(y - startY)
            axis = when {
                dx >= horizontalSlop && dx >= dy * 0.75f -> Axis.HORIZONTAL
                dy >= verticalSlop -> Axis.VERTICAL
                else -> Axis.PENDING
            }
        }
        return axis
    }
}
