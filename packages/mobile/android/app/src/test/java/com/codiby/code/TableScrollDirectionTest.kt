package com.codiby.code

import org.junit.Assert.assertEquals
import org.junit.Test
import com.codiby.code.TableScrollDirection.Axis

class TableScrollDirectionTest {
    private val direction = TableScrollDirection(6f, 20f)

    @Test fun verticalWobbleBeforeHorizontalDragDoesNotGiveAwayTheGesture() {
        direction.start(300f, 100f)
        assertEquals(Axis.PENDING, direction.move(298f, 112f))
        assertEquals(Axis.HORIZONTAL, direction.move(288f, 114f))
        assertEquals(Axis.HORIZONTAL, direction.move(200f, 170f))
    }

    @Test fun worksInBothHorizontalDirections() {
        for (sign in listOf(-1, 1)) {
            direction.start(100f, 100f)
            assertEquals(Axis.HORIZONTAL, direction.move(100f + sign * 8, 102f))
        }
    }

    @Test fun clearlyVerticalMotionBelongsToTheChat() {
        direction.start(100f, 100f)
        assertEquals(Axis.PENDING, direction.move(102f, 110f))
        assertEquals(Axis.VERTICAL, direction.move(103f, 121f))
        assertEquals(Axis.VERTICAL, direction.move(180f, 160f))
    }

    @Test fun nextTouchChoosesItsAxisIndependently() {
        direction.start(0f, 0f)
        direction.move(0f, 30f)
        direction.start(100f, 200f)
        assertEquals(Axis.PENDING, direction.axis)
        assertEquals(Axis.HORIZONTAL, direction.move(110f, 202f))
    }
}
